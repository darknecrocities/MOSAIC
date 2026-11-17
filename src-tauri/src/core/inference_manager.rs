use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio::task::AbortHandle;

use crate::core::ollama_manager;
use crate::security::command_guard;

#[derive(Debug, Error)]
pub enum InferenceError {
    #[error("external model library is required before running models")]
    ExternalDriveRequired,
    #[error("security validation failed: {0}")]
    Security(#[from] crate::security::SecurityError),
    #[error("ollama endpoint error: {0}")]
    Ollama(#[from] ollama_manager::OllamaError),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Default)]
pub struct InferenceRegistry {
    active: Arc<Mutex<Option<(String, AbortHandle)>>>,
}

impl InferenceRegistry {
    pub fn is_running(&self) -> bool {
        self.active.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn stop_active(&self) -> bool {
        if let Ok(mut guard) = self.active.lock() {
            if let Some((_, handle)) = guard.take() {
                handle.abort();
                return true;
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
        if !library_connected {
            return Err(InferenceError::ExternalDriveRequired);
        }
        command_guard::validate_model_name(&req.model)?;
        let base_url = ollama_manager::validate_loopback_endpoint(&endpoint)?;

        self.stop_active();
        let registry = self.active.clone();
        let sid = req.session_id.clone();
        let num_ctx = req.num_ctx.unwrap_or(4096);
        let temperature = req.temperature.unwrap_or(0.2);

        let task = tokio::spawn(async move {
            let res = stream_chat(
                &app,
                base_url.as_str(),
                &sid,
                &req.model,
                &req.messages,
                num_ctx,
                temperature,
            )
            .await;

            if let Err(err) = res {
                let _ = app.emit(
                    "mosaic://chat-token",
                    ChatTokenEvent {
                        session_id: sid.clone(),
                        token: String::new(),
                        done: true,
                        error: Some(err.to_string()),
                    },
                );
            }
            if let Ok(mut guard) = registry.lock() {
                *guard = None;
            }
        });

        if let Ok(mut guard) = self.active.lock() {
            *guard = Some((req.session_id, task.abort_handle()));
        }
        Ok(())
    }
}

async fn stream_chat(
    app: &AppHandle,
    base_url: &str,
    session_id: &str,
    model: &str,
    messages: &[ChatMessage],
    num_ctx: u32,
    temperature: f32,
) -> Result<(), InferenceError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()?;
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let mut resp = client
        .post(&url)
        .json(&serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "options": {
                "num_ctx": num_ctx.clamp(512, 131_072),
                "temperature": temperature.clamp(0.0, 2.0),
            }
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(InferenceError::RemoteError(format!(
            "HTTP {}",
            resp.status()
        )));
    }

    let mut buffer = String::new();
    while let Some(chunk) = resp.chunk().await? {
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
                let _ = app.emit(
                    "mosaic://chat-token",
                    ChatTokenEvent {
                        session_id: session_id.to_string(),
                        token,
                        done,
                        error: None,
                    },
                );
            }
        }
    }
    Ok(())
}

pub async fn unload_model(endpoint: &str, model: &str) -> Result<(), InferenceError> {
    command_guard::validate_model_name(model)?;
    let base_url = ollama_manager::validate_loopback_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()?;
    let url = format!("{}/api/generate", base_url.as_str().trim_end_matches('/'));
    let _ = client
        .post(&url)
        .json(&serde_json::json!({ "model": model, "keep_alive": 0 }))
        .send()
        .await?;
    Ok(())
}
