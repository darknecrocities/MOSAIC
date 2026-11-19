use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::core::{ollama_manager, settings_policy};

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
