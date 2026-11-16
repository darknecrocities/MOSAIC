pub mod command_guard;
pub mod path_guard;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SecurityError {
    #[error("path escapes configured boundary")]
    PathOutsideBoundary,
    #[error("invalid path component or parent traversal detected")]
    InvalidPath,
    #[error("binary '{0}' is not in the allow-list")]
    BinaryNotAllowed(String),
    #[error("invalid argument rejected: {0}")]
    InvalidArgument(String),
    #[error("invalid model identifier: {0}")]
    InvalidModelName(String),
    #[error("failed to execute '{binary}': {message}")]
    CommandExecution { binary: String, message: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
