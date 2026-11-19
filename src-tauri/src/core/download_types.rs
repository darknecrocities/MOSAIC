use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::core::ollama_manager;

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

pub enum PullOutcome {
    Completed { emitted_done: bool },
    Cancelled,
}

pub fn process_pull_line<F>(
    line: &str,
    model: &str,
    emitted_done: &mut bool,
    emit: &mut F,
) -> Result<(), DownloadError>
where
    F: FnMut(PullProgressEvent),
{
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
        if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
            return Err(DownloadError::RemoteError(err.to_string()));
        }
        let status = val
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("downloading")
            .to_string();
        let done = status == "success";
        if done {
            *emitted_done = true;
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
    Ok(())
}
