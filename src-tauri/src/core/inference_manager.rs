use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

use crate::commands::AppState;
pub use crate::core::inference_types::{
    build_ollama_chat_payload, ChatMessage, ChatStreamRequest, ChatTokenEvent, InferenceError,
};
use crate::core::stream_lines::LineByteBuffer;
use crate::core::{ollama_manager, telemetry};
use crate::security::command_guard;

const DEFAULT_CHAT_CHUNK_TIMEOUT: Duration = Duration::from_secs(180);

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
        emit: F,
    ) -> Result<(), InferenceError>
    where
        F: FnMut(ChatTokenEvent) + Send + 'static,
    {
        self.start_chat_with_sink_and_timeout(
            endpoint,
            req,
            library_connected,
            DEFAULT_CHAT_CHUNK_TIMEOUT,
            emit,
        )
    }

    pub fn start_chat_with_sink_and_timeout<F>(
        &self,
        endpoint: String,
        req: ChatStreamRequest,
        library_connected: bool,
        chunk_timeout: Duration,
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
                stream_chat(base_url.as_str(), &sid, &payload, chunk_timeout, &mut cancel_rx, &mut emit).await
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

fn process_chat_line<F>(
    line: &str,
    session_id: &str,
    sent_done: &mut bool,
    emit: &mut F,
) -> Result<(), InferenceError>
where
    F: FnMut(ChatTokenEvent),
{
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
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
            *sent_done = true;
        }
        emit(ChatTokenEvent {
            session_id: session_id.to_string(),
            token,
            done,
            error: None,
        });
    }
    Ok(())
}

async fn stream_chat<F>(
    base_url: &str,
    session_id: &str,
    payload: &serde_json::Value,
    chunk_timeout: Duration,
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

    let mut line_buf = LineByteBuffer::default();
    let mut sent_done = false;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = wait_cancelled(cancel_rx) => return Ok(ChatOutcome::Cancelled),
            res = tokio::time::timeout(chunk_timeout, resp.chunk()) => match res {
                Ok(Ok(chunk)) => chunk,
                Ok(Err(e)) if e.is_timeout() => return Err(InferenceError::RemoteError(
                    "Chat stream timed out waiting for Ollama response.".into(),
                )),
                Ok(Err(e)) => return Err(InferenceError::Http(e)),
                Err(_) => return Err(InferenceError::RemoteError(
                    "Chat stream timed out waiting for Ollama response.".into(),
                )),
            },
        };
        let Some(chunk) = chunk else {
            if let Some(tail) = line_buf.flush_remaining() {
                process_chat_line(&tail, session_id, &mut sent_done, emit)?;
            }
            break;
        };
        for line in line_buf.push_chunk(&chunk) {
            process_chat_line(&line, session_id, &mut sent_done, emit)?;
        }
    }
    if !sent_done {
        return Err(InferenceError::RemoteError(
            "Chat stream ended unexpectedly before completion.".into(),
        ));
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
