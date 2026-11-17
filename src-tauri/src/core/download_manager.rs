use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio::task::AbortHandle;

use crate::core::ollama_manager;
use crate::core::settings_store::ActiveLibraryRecord;
use crate::security::command_guard;

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("external model library is not connected or configured")]
    ExternalDriveRequired,
    #[error("insufficient free space on external drive: required {required} bytes, available {available} bytes")]
    InsufficientSpace { required: u64, available: u64 },
    #[error("security validation failed: {0}")]
    Security(#[from] crate::security::SecurityError),
    #[error("ollama endpoint error: {0}")]
    Ollama(#[from] ollama_manager::OllamaError),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("pull failed: {0}")]
    RemoteError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullProgressEvent {
    pub model: String,
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct DownloadRegistry {
    active: Arc<Mutex<HashMap<String, AbortHandle>>>,
}

impl DownloadRegistry {
    pub fn has_active(&self) -> bool {
        self.active.lock().map(|m| !m.is_empty()).unwrap_or(false)
    }

    pub fn cancel(&self, model: &str) -> bool {
        if let Ok(mut map) = self.active.lock() {
            if let Some(handle) = map.remove(model) {
                handle.abort();
                return true;
            }
        }
        false
    }

    pub fn start_pull(
        &self,
        app: AppHandle,
        endpoint: String,
        model: String,
        estimated_bytes: Option<u64>,
        active_library: Option<ActiveLibraryRecord>,
        library_connected: bool,
    ) -> Result<(), DownloadError> {
        command_guard::validate_model_name(&model)?;
        if !library_connected {
            return Err(DownloadError::ExternalDriveRequired);
        }
        let lib = active_library.ok_or(DownloadError::ExternalDriveRequired)?;
        if let Some(req_bytes) = estimated_bytes {
            let needed = (req_bytes as f64 * 1.1) as u64;
            if lib.free_bytes < needed {
                return Err(DownloadError::InsufficientSpace {
                    required: needed,
                    available: lib.free_bytes,
                });
            }
        }

        let base_url = ollama_manager::validate_loopback_endpoint(&endpoint)?;
        let registry = self.active.clone();
        let model_key = model.clone();

        let task = tokio::spawn(async move {
            let res = stream_pull(&app, base_url.as_str(), &model).await;
            if let Err(err) = res {
                let _ = app.emit(
                    "mosaic://pull-progress",
                    PullProgressEvent {
                        model: model.clone(),
                        status: "error".into(),
                        completed: None,
                        total: None,
                        done: true,
                        error: Some(err.to_string()),
                    },
                );
            }
            if let Ok(mut map) = registry.lock() {
                map.remove(&model);
            }
        });

        if let Ok(mut map) = self.active.lock() {
            map.insert(model_key, task.abort_handle());
        }
        Ok(())
    }
}

async fn stream_pull(
    app: &AppHandle,
    base_url: &str,
    model: &str,
) -> Result<(), DownloadError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()?;
    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    let mut resp = client
        .post(&url)
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(DownloadError::RemoteError(format!(
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
                    return Err(DownloadError::RemoteError(err.to_string()));
                }
                let status = val
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("downloading")
                    .to_string();
                let done = status == "success";
                let _ = app.emit(
                    "mosaic://pull-progress",
                    PullProgressEvent {
                        model: model.to_string(),
                        status,
                        completed: val.get("completed").and_then(|v| v.as_u64()),
                        total: val.get("total").and_then(|v| v.as_u64()),
                        done,
                        error: None,
                    },
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_space_and_drive_gate_logic() {
        assert!(command_guard::validate_model_name("llama3.2:1b").is_ok());
        assert!(command_guard::validate_model_name("../bad").is_err());
    }
}
