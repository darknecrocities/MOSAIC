use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tokio::sync::watch;

use crate::commands::AppState;
use crate::core::{ollama_manager, telemetry};
use crate::core::settings_store::ActiveLibraryRecord;
use crate::security::command_guard;

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("external model library is not connected or configured")]
    ExternalDriveRequired,
    #[error("pull already in progress for model: {0}")]
    AlreadyInProgress(String),
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PullProgressEvent {
    pub model: String,
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

struct ActiveDownload {
    run_id: u64,
    cancel_tx: watch::Sender<bool>,
}

#[derive(Default)]
struct DownloadState {
    next_id: u64,
    entries: HashMap<String, ActiveDownload>,
}

#[derive(Default)]
pub struct DownloadRegistry {
    active: Arc<Mutex<DownloadState>>,
}

pub enum PullOutcome {
    Completed { emitted_done: bool },
    Cancelled,
}

impl DownloadRegistry {
    pub fn has_active(&self) -> bool {
        self.active.lock().map(|s| !s.entries.is_empty()).unwrap_or(false)
    }

    pub fn cancel(&self, model: &str) -> bool {
        if let Ok(mut state) = self.active.lock() {
            if let Some(entry) = state.entries.remove(model) {
                let _ = entry.cancel_tx.send(true);
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
        let app_for_emit = app.clone();
        let app_for_log = app;
        self.start_pull_with_sink(
            endpoint,
            model,
            estimated_bytes,
            active_library,
            library_connected,
            move |ev| {
                if ev.status == "cancelled" {
                    if let Some(st) = app_for_log.try_state::<AppState>() {
                        let _ = telemetry::log_diagnostic(
                            &st.store,
                            "info",
                            "download_manager",
                            &format!("Cancelled pull for {}", ev.model),
                        );
                    }
                } else if ev.status == "error" {
                    if let Some(st) = app_for_log.try_state::<AppState>() {
                        let _ = telemetry::log_diagnostic(
                            &st.store,
                            "error",
                            "download_manager",
                            &format!("Pull failed for {}: {}", ev.model, ev.error.as_deref().unwrap_or("unknown")),
                        );
                    }
                }
                let _ = app_for_emit.emit("mosaic://pull-progress", ev);
            },
        )
    }

    pub fn start_pull_with_sink<F>(
        &self,
        endpoint: String,
        model: String,
        estimated_bytes: Option<u64>,
        active_library: Option<ActiveLibraryRecord>,
        library_connected: bool,
        mut emit: F,
    ) -> Result<(), DownloadError>
    where
        F: FnMut(PullProgressEvent) + Send + 'static,
    {
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

        let (run_id, mut cancel_rx) = {
            let mut state = self
                .active
                .lock()
                .map_err(|_| DownloadError::RemoteError("download registry lock poisoned".into()))?;
            if state.entries.contains_key(&model) {
                return Err(DownloadError::AlreadyInProgress(model));
            }
            state.next_id += 1;
            let run_id = state.next_id;
            let (cancel_tx, cancel_rx) = watch::channel(false);
            state.entries.insert(model.clone(), ActiveDownload { run_id, cancel_tx });
            (run_id, cancel_rx)
        };

        let registry = self.active.clone();
        tokio::spawn(async move {
            match stream_pull(base_url.as_str(), &model, &mut cancel_rx, &mut emit).await {
                Ok(PullOutcome::Cancelled) => {
                    emit(PullProgressEvent {
                        model: model.clone(),
                        status: "cancelled".into(),
                        completed: None,
                        total: None,
                        done: true,
                        error: Some("Pull cancelled by user.".into()),
                    });
                }
                Ok(PullOutcome::Completed { emitted_done }) => {
                    if !emitted_done {
                        emit(PullProgressEvent {
                            model: model.clone(),
                            status: "success".into(),
                            completed: None,
                            total: None,
                            done: true,
                            error: None,
                        });
                    }
                }
                Err(err) => {
                    emit(PullProgressEvent {
                        model: model.clone(),
                        status: "error".into(),
                        completed: None,
                        total: None,
                        done: true,
                        error: Some(err.to_string()),
                    });
                }
            }
            if let Ok(mut state) = registry.lock() {
                if state.entries.get(&model).is_some_and(|e| e.run_id == run_id) {
                    state.entries.remove(&model);
                }
            }
        });
        Ok(())
    }
}

async fn wait_cancelled(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|v| *v).await;
}

async fn stream_pull<F>(
    base_url: &str,
    model: &str,
    cancel_rx: &mut watch::Receiver<bool>,
    emit: &mut F,
) -> Result<PullOutcome, DownloadError>
where
    F: FnMut(PullProgressEvent),
{
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()?;
    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    let mut resp = tokio::select! {
        biased;
        _ = wait_cancelled(cancel_rx) => return Ok(PullOutcome::Cancelled),
        res = client.post(&url).json(&serde_json::json!({ "model": model, "stream": true })).send() => res?,
    };

    if !resp.status().is_success() {
        return Err(DownloadError::RemoteError(format!("HTTP {}", resp.status())));
    }

    let mut buffer = String::new();
    let mut emitted_done = false;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = wait_cancelled(cancel_rx) => return Ok(PullOutcome::Cancelled),
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
                    return Err(DownloadError::RemoteError(err.to_string()));
                }
                let status = val.get("status").and_then(|v| v.as_str()).unwrap_or("downloading").to_string();
                let done = status == "success";
                if done {
                    emitted_done = true;
                }
                emit(PullProgressEvent {
                    model: model.to_string(),
                    status,
                    completed: val.get("completed").and_then(|v| v.as_u64()),
                    total: val.get("total").and_then(|v| v.as_u64()),
                    done,
                    error: None,
                });
            }
        }
    }
    Ok(PullOutcome::Completed { emitted_done })
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
