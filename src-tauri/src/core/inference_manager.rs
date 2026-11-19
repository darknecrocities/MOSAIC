use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tokio::sync::watch;

use crate::commands::AppState;
use crate::core::{ollama_manager, settings_policy, telemetry};
use crate::security::command_guard;

#[derive(Debug, Error)]
pub enum InferenceError {
    #[error("external model library is required before running models")]
    ExternalDriveRequired,
    #[error("security validation failed: {0}")]
    Security(#[from] crate::security::SecurityError),
    #[error("ollama endpoint error: {0}")]
    Ollama(#[from] ollama_manager::OllamaError),
    #[error("invalid inference option: {0}")]
    InvalidOption(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("inference error: {0}")]
    RemoteError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatTokenEvent {
    pub session_id: String,
    pub token: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatStreamRequest {
    pub session_id: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub num_ctx: Option<u32>,
    pub temperature: Option<f32>,
    #[serde(default)]
    pub execution_profile: Option<String>,
    #[serde(default)]
    pub kv_cache_type: Option<String>,
    #[serde(default)]
    pub num_gpu: Option<i32>,
    #[serde(default)]
    pub num_batch: Option<u32>,
    #[serde(default)]
    pub num_ubatch: Option<u32>,
    #[serde(default)]
    pub num_thread: Option<u32>,
    #[serde(default)]
    pub use_mmap: Option<bool>,
    #[serde(default)]
    pub use_mlock: Option<bool>,
    #[serde(default)]
    pub keep_alive: Option<String>,
}

struct ActiveInference {
    run_id: u64,
    cancelling: bool,
    cancel_tx: watch::Sender<bool>,
    done_tx: watch::Sender<bool>,
}

#[derive(Default)]
struct InferenceState {
    next_id: u64,
    current: Option<ActiveInference>,
}

#[derive(Default)]
pub struct InferenceRegistry {
    active: Arc<Mutex<InferenceState>>,
}

enum ChatOutcome {
    Completed { sent_done: bool },
    Cancelled,
}

pub fn build_ollama_chat_payload(req: &ChatStreamRequest) -> Result<serde_json::Value, InferenceError> {
    let mut options = serde_json::Map::new();
    let num_ctx = req.num_ctx.unwrap_or(4096).clamp(512, 131_072);
    let temperature = req.temperature.unwrap_or(0.2).clamp(0.0, 2.0);
    options.insert("num_ctx".into(), serde_json::json!(num_ctx));
    options.insert("temperature".into(), serde_json::json!(temperature));
    if let Some(ngl) = req.num_gpu {
        options.insert("num_gpu".into(), serde_json::json!(ngl.clamp(0, 999)));
    }
    if let Some(nb) = req.num_batch {
        options.insert("num_batch".into(), serde_json::json!(nb.clamp(1, 8192)));
    }
    if let Some(nub) = req.num_ubatch {
        options.insert("num_ubatch".into(), serde_json::json!(nub.clamp(1, 8192)));
    }
    if let Some(nt) = req.num_thread {
        options.insert("num_thread".into(), serde_json::json!(nt.clamp(1, 1024)));
    }
    if let Some(mmap) = req.use_mmap {
        options.insert("use_mmap".into(), serde_json::json!(mmap));
    }
    if let Some(mlock) = req.use_mlock {
        options.insert("use_mlock".into(), serde_json::json!(mlock));
    }

    let mut body = serde_json::json!({
        "model": req.model,
        "messages": req.messages,
        "stream": true,
        "options": serde_json::Value::Object(options),
    });
    if let Some(ref ka) = req.keep_alive {
        let valid_ka = settings_policy::validate_keep_alive(ka)
            .map_err(InferenceError::InvalidOption)?;
        body["keep_alive"] = serde_json::json!(valid_ka);
    }
    Ok(body)
}

impl InferenceRegistry {
    pub fn is_running(&self) -> bool {
        self.active.lock().map(|g| g.current.is_some()).unwrap_or(false)
    }

    pub fn stop_active(&self) -> bool {
        if let Ok(mut guard) = self.active.lock() {
            if let Some(entry) = guard.current.as_mut() {
                if !entry.cancelling {
                    entry.cancelling = true;
                    let _ = entry.cancel_tx.send(true);
                    return true;
                }
            }
        }
        false
    }

    pub fn start_chat(
        &self,
        app: AppHandle,
        endpoint: String,
        req: ChatStreamRequest,
        library_connected: bool,
    ) -> Result<(), InferenceError> {
        let app_for_emit = app.clone();
        let app_for_log = app;
        self.start_chat_with_sink(endpoint, req, library_connected, move |ev| {
            if let Some(err) = ev.error.as_deref() {
                if let Some(st) = app_for_log.try_state::<AppState>() {
                    let _ = telemetry::log_diagnostic(
                        &st.store,
                        "error",
                        "inference_manager",
                        &format!("Chat stream error: {err}"),
                    );
                }
            }
            let _ = app_for_emit.emit("mosaic://chat-token", ev);
        })
    }

    pub fn start_chat_with_sink<F>(
        &self,
        endpoint: String,
        req: ChatStreamRequest,
        library_connected: bool,
        mut emit: F,
    ) -> Result<(), InferenceError>
    where
        F: FnMut(ChatTokenEvent) + Send + 'static,
    {
        if !library_connected {
            return Err(InferenceError::ExternalDriveRequired);
        }
        command_guard::validate_model_name(&req.model)?;
        let base_url = ollama_manager::validate_loopback_endpoint(&endpoint)?;
        let payload = build_ollama_chat_payload(&req)?;

        let (run_id, mut cancel_rx, done_tx, prev_done_rx) = {
            let mut guard = self
                .active
                .lock()
                .map_err(|_| InferenceError::RemoteError("inference lock poisoned".into()))?;
            let prev_done_rx = guard.current.take().map(|prev| {
                let rx = prev.done_tx.subscribe();
                let _ = prev.cancel_tx.send(true);
                rx
            });
            guard.next_id += 1;
            let run_id = guard.next_id;
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let (done_tx, _) = watch::channel(false);
            guard.current = Some(ActiveInference {
                run_id,
                cancelling: false,
                cancel_tx,
                done_tx: done_tx.clone(),
            });
            (run_id, cancel_rx, done_tx, prev_done_rx)
        };

        let registry = self.active.clone();
        let sid = req.session_id;
        tokio::spawn(async move {
            if let Some(mut prev_done) = prev_done_rx {
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    prev_done.wait_for(|done| *done),
                )
                .await;
            }
            let outcome = if *cancel_rx.borrow() {
                Ok(ChatOutcome::Cancelled)
            } else {
                stream_chat(base_url.as_str(), &sid, &payload, &mut cancel_rx, &mut emit).await
            };
            let terminal_err = match outcome {
                Ok(ChatOutcome::Cancelled) => Some(None),
                Ok(ChatOutcome::Completed { sent_done }) => (!sent_done).then_some(None),
                Err(err) => Some(Some(err.to_string())),
            };
            if let Some(error) = terminal_err {
                emit(ChatTokenEvent {
                    session_id: sid.clone(),
                    token: String::new(),
                    done: true,
                    error,
                });
            }
            if let Ok(mut guard) = registry.lock() {
                if guard.current.as_ref().is_some_and(|e| e.run_id == run_id) {
                    guard.current = None;
                }
            }
            let _ = done_tx.send(true);
        });
        Ok(())
    }
}

async fn wait_cancelled(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|v| *v).await;
}

async fn stream_chat<F>(
    base_url: &str,
    session_id: &str,
    payload: &serde_json::Value,
    cancel_rx: &mut watch::Receiver<bool>,
    emit: &mut F,
) -> Result<ChatOutcome, InferenceError>
where
    F: FnMut(ChatTokenEvent),
{
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()?;
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let mut resp = tokio::select! {
        biased;
        _ = wait_cancelled(cancel_rx) => return Ok(ChatOutcome::Cancelled),
        res = client.post(&url).json(payload).send() => res?,
    };

    if !resp.status().is_success() {
        return Err(InferenceError::RemoteError(format!("HTTP {}", resp.status())));
    }

    let mut buffer = String::new();
    let mut sent_done = false;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = wait_cancelled(cancel_rx) => return Ok(ChatOutcome::Cancelled),
            res = resp.chunk() => res?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find('\n') {
            let line = buffer[..idx].trim().to_string();
            buffer.drain(..=idx);
            if line.is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                    return Err(InferenceError::RemoteError(err.to_string()));
                }
                let token = val
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let done = val.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
                if done {
                    sent_done = true;
                }
                emit(ChatTokenEvent {
                    session_id: session_id.to_string(),
                    token,
                    done,
                    error: None,
                });
            }
        }
    }
    Ok(ChatOutcome::Completed { sent_done })
}

pub async fn unload_model(endpoint: &str, model: &str) -> Result<(), InferenceError> {
    command_guard::validate_model_name(model)?;
    let base_url = ollama_manager::validate_loopback_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()?;
    let url = format!("{}/api/generate", base_url.as_str().trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "model": model, "keep_alive": 0 }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(InferenceError::RemoteError(format!("HTTP {}", resp.status())));
    }
    Ok(())
}
