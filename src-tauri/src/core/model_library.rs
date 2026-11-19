use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::core::ollama_manager;
use crate::security::command_guard;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("security validation failed: {0}")]
    Security(#[from] crate::security::SecurityError),
    #[error("ollama endpoint error: {0}")]
    Ollama(#[from] ollama_manager::OllamaError),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("ollama returned HTTP {0}")]
    RemoteStatus(u16),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledModel {
    pub name: String,
    pub size_bytes: u64,
    pub digest: String,
    pub modified_at: String,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ModelShowInfo {
    pub format: Option<String>,
    pub family: Option<String>,
    pub families: Option<Vec<String>>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ModelShowDetails {
    pub model: String,
    pub modelfile: Option<String>,
    pub parameters: Option<String>,
    pub template: Option<String>,
    pub license: Option<String>,
    pub details: Option<ModelShowInfo>,
    pub model_info: Option<serde_json::Value>,
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<TagItem>,
}

#[derive(Debug, Deserialize)]
struct TagItem {
    name: String,
    size: u64,
    digest: String,
    modified_at: String,
    details: Option<TagDetails>,
}

#[derive(Debug, Deserialize)]
struct TagDetails {
    family: Option<String>,
    parameter_size: Option<String>,
    quantization_level: Option<String>,
}

pub async fn list_installed_models(endpoint: &str) -> Result<Vec<InstalledModel>, LibraryError> {
    let base_url = ollama_manager::validate_loopback_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()?;

    let url = format!("{}/api/tags", base_url.as_str().trim_end_matches('/'));
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(LibraryError::RemoteStatus(resp.status().as_u16()));
    }

    let parsed = resp.json::<TagsResponse>().await?;
    Ok(parsed
        .models
        .into_iter()
        .map(|m| InstalledModel {
            name: m.name,
            size_bytes: m.size,
            digest: m.digest,
            modified_at: m.modified_at,
            family: m.details.as_ref().and_then(|d| d.family.clone()),
            parameter_size: m.details.as_ref().and_then(|d| d.parameter_size.clone()),
            quantization_level: m.details.as_ref().and_then(|d| d.quantization_level.clone()),
        })
        .collect())
}

pub async fn show_model_details(
    endpoint: &str,
    model: &str,
) -> Result<ModelShowDetails, LibraryError> {
    command_guard::validate_model_name(model)?;
    let base_url = ollama_manager::validate_loopback_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()?;

    let url = format!("{}/api/show", base_url.as_str().trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(LibraryError::RemoteStatus(resp.status().as_u16()));
    }
    let mut parsed = resp.json::<ModelShowDetails>().await?;
    if parsed.model.is_empty() {
        parsed.model = model.to_string();
    }
    Ok(parsed)
}

pub async fn delete_installed_model(endpoint: &str, model: &str) -> Result<(), LibraryError> {
    command_guard::validate_model_name(model)?;
    let base_url = ollama_manager::validate_loopback_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .build()?;

    let url = format!("{}/api/delete", base_url.as_str().trim_end_matches('/'));
    let resp = client
        .delete(&url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(LibraryError::RemoteStatus(resp.status().as_u16()));
    }
    Ok(())
}
