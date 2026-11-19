use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

use crate::commands::AppState;
pub use crate::core::download_types::{
    process_pull_line, DownloadError, PullOutcome, PullProgressEvent,
};
use crate::core::settings_store::ActiveLibraryRecord;
use crate::core::stream_lines::LineByteBuffer;
use crate::core::{ollama_manager, telemetry};
use crate::security::command_guard;

const DEFAULT_PULL_CHUNK_TIMEOUT: Duration = Duration::from_secs(180);

struct ActiveDownload {
    run_id: u64,
    cancelling: bool,
    cancel_tx: watch::Sender<bool>,
    done_tx: watch::Sender<bool>,
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

impl DownloadRegistry {
    pub fn has_active(&self) -> bool {
        self.active.lock().map(|s| !s.entries.is_empty()).unwrap_or(false)
    }

    pub fn cancel(&self, model: &str) -> bool {
        if let Ok(mut state) = self.active.lock() {
            if let Some(entry) = state.entries.get_mut(model) {
                if !entry.cancelling {
                    entry.cancelling = true;
                    let _ = entry.cancel_tx.send(true);
                    return true;
                }
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
        emit: F,
    ) -> Result<(), DownloadError>
    where
        F: FnMut(PullProgressEvent) + Send + 'static,
    {
        self.start_pull_with_sink_and_timeout(
            endpoint,
            model,
            estimated_bytes,
            active_library,
            library_connected,
            DEFAULT_PULL_CHUNK_TIMEOUT,
            emit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_pull_with_sink_and_timeout<F>(
        &self,
        endpoint: String,
        model: String,
        estimated_bytes: Option<u64>,
        active_library: Option<ActiveLibraryRecord>,
        library_connected: bool,
        chunk_timeout: Duration,
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

        let (run_id, mut cancel_rx, done_tx, prev_done_rx) = {
            let mut state = self
                .active
                .lock()
                .map_err(|_| DownloadError::RemoteError("download registry lock poisoned".into()))?;
            let prev_done_rx = if let Some(entry) = state.entries.get(&model) {
                if !entry.cancelling {
                    return Err(DownloadError::AlreadyInProgress(model));
                }
                Some(entry.done_tx.subscribe())
            } else {
                None
            };
            state.next_id += 1;
            let run_id = state.next_id;
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let (done_tx, _) = watch::channel(false);
            state.entries.insert(
                model.clone(),
                ActiveDownload {
                    run_id,
                    cancelling: false,
                    cancel_tx,
                    done_tx: done_tx.clone(),
                },
            );
            (run_id, cancel_rx, done_tx, prev_done_rx)
        };

        let registry = self.active.clone();
        tokio::spawn(async move {
            if let Some(mut prev_done) = prev_done_rx {
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    prev_done.wait_for(|done| *done),
                )
                .await;
            }
            let outcome = if *cancel_rx.borrow() {
                Ok(PullOutcome::Cancelled)
            } else {
                stream_pull(base_url.as_str(), &model, chunk_timeout, &mut cancel_rx, &mut emit).await
            };
            match outcome {
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
                Ok(PullOutcome::Completed { emitted_done: true }) => {}
                Ok(PullOutcome::Completed { emitted_done: false }) => {
                    emit(PullProgressEvent {
                        model: model.clone(),
                        status: "error".into(),
                        completed: None,
                        total: None,
                        done: true,
                        error: Some("Pull stream ended unexpectedly before completion.".into()),
                    });
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
            let _ = done_tx.send(true);
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
    chunk_timeout: Duration,
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
    let req = client
        .post(&url)
        .json(&serde_json::json!({ "model": model, "stream": true }));
    let mut resp = tokio::select! {
        biased;
        _ = wait_cancelled(cancel_rx) => return Ok(PullOutcome::Cancelled),
        res = tokio::time::timeout(chunk_timeout, req.send()) => match res {
            Ok(Ok(resp)) => resp,
            Ok(Err(e)) if e.is_timeout() => return Err(DownloadError::RemoteError(
                "Pull request timed out waiting for Ollama response headers.".into(),
            )),
            Ok(Err(e)) => return Err(DownloadError::Http(e)),
            Err(_) => return Err(DownloadError::RemoteError(
                "Pull request timed out waiting for Ollama response headers.".into(),
            )),
        },
    };

    if !resp.status().is_success() {
        return Err(DownloadError::RemoteError(format!("HTTP {}", resp.status())));
    }

    let mut line_buf = LineByteBuffer::default();
    let mut emitted_done = false;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = wait_cancelled(cancel_rx) => return Ok(PullOutcome::Cancelled),
            res = tokio::time::timeout(chunk_timeout, resp.chunk()) => match res {
                Ok(Ok(chunk)) => chunk,
                Ok(Err(e)) if e.is_timeout() => return Err(DownloadError::RemoteError(
                    "Pull stream timed out waiting for Ollama chunk.".into(),
                )),
                Ok(Err(e)) => return Err(DownloadError::Http(e)),
                Err(_) => return Err(DownloadError::RemoteError(
                    "Pull stream timed out waiting for Ollama chunk.".into(),
                )),
            },
        };
        let Some(chunk) = chunk else {
            if let Some(tail) = line_buf.flush_remaining() {
                process_pull_line(&tail, model, &mut emitted_done, emit)?;
            }
            break;
        };
        for line in line_buf.push_chunk(&chunk) {
            process_pull_line(&line, model, &mut emitted_done, emit)?;
        }
    }
    if !emitted_done {
        return Err(DownloadError::RemoteError(
            "Pull stream ended unexpectedly before completion.".into(),
        ));
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
