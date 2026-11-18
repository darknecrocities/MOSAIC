use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::security::command_guard;

pub const DEFAULT_OLLAMA_ENDPOINT: &str = "http://127.0.0.1:11434";

#[derive(Debug, Error)]
pub enum OllamaError {
    #[error("endpoint must be loopback (127.0.0.1 or localhost) by default: {0}")]
    NonLoopbackEndpoint(String),
    #[error("http client error: {0}")]
    Http(#[from] reqwest::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub app_bundle_present: bool,
    pub cli_version: Option<String>,
    pub api_reachable: bool,
    pub api_version: Option<String>,
    pub endpoint: String,
    pub env_ollama_models: Option<String>,
    pub launchd_ollama_models: Option<String>,
    pub runtime_mode: String,
}

#[derive(Debug, Deserialize)]
struct VersionResponse {
    version: String,
}

pub fn validate_loopback_endpoint(endpoint: &str) -> Result<reqwest::Url, OllamaError> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|_| OllamaError::NonLoopbackEndpoint(endpoint.to_string()))?;
    let host = url.host_str().unwrap_or("");
    let is_loopback = host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]";
    if url.scheme() == "http" && is_loopback {
        Ok(url)
    } else {
        Err(OllamaError::NonLoopbackEndpoint(endpoint.to_string()))
    }
}

pub fn detect_ollama_binary() -> Option<PathBuf> {
    let candidates = [
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
        "/usr/bin/ollama",
    ];
    for candidate in candidates {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path.to_path_buf());
        }
    }
    None
}

pub async fn inspect_ollama(endpoint: Option<&str>) -> Result<OllamaStatus, OllamaError> {
    let target = endpoint.unwrap_or(DEFAULT_OLLAMA_ENDPOINT);
    let base_url = validate_loopback_endpoint(target)?;

    let binary_path = detect_ollama_binary();
    let app_bundle_present = Path::new("/Applications/Ollama.app").exists();

    let cli_version = binary_path
        .as_deref()
        .and_then(|bin| command_guard::run_allowlisted(bin, &["--version"]).ok())
        .filter(|out| out.status.success())
        .and_then(|out| parse_cli_version(&String::from_utf8_lossy(&out.stdout)));

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()?;

    let version_url = format!("{}/api/version", base_url.as_str().trim_end_matches('/'));
    let (api_reachable, api_version) = match client.get(&version_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let parsed = resp.json::<VersionResponse>().await.ok();
            (true, parsed.map(|v| v.version))
        }
        _ => (false, None),
    };

    let env_ollama_models = std::env::var("OLLAMA_MODELS").ok().filter(|v| !v.is_empty());
    let launchd_ollama_models = read_launchd_ollama_models();

    let runtime_mode = if app_bundle_present {
        "macos_app_or_cli".to_string()
    } else if binary_path.is_some() {
        "cli_service".to_string()
    } else {
        "not_installed".to_string()
    };

    Ok(OllamaStatus {
        installed: binary_path.is_some() || app_bundle_present,
        binary_path: binary_path.map(|p| p.display().to_string()),
        app_bundle_present,
        cli_version,
        api_reachable,
        api_version,
        endpoint: target.to_string(),
        env_ollama_models,
        launchd_ollama_models,
        runtime_mode,
    })
}

#[cfg(target_os = "macos")]
fn read_launchd_ollama_models() -> Option<String> {
    let out = command_guard::run_allowlisted(
        Path::new("/bin/launchctl"),
        &["getenv", "OLLAMA_MODELS"],
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if val.is_empty() {
        None
    } else {
        Some(val)
    }
}

#[cfg(not(target_os = "macos"))]
fn read_launchd_ollama_models() -> Option<String> {
    None
}

pub fn parse_cli_version(raw: &str) -> Option<String> {
    let re = regex::Regex::new(r"(\d+\.\d+\.\d+)").ok()?;
    re.captures(raw)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Configure OLLAMA_MODELS with an explicit backup of prior configuration.
pub fn configure_ollama_models_dir(
    library_path: &str,
    backup_dir: &Path,
    confirmed: bool,
) -> Result<String, String> {
    if !confirmed {
        return Err("Explicit user confirmation is required before changing OLLAMA_MODELS.".into());
    }
    if library_path.trim().is_empty() {
        return Err("External library path cannot be empty.".into());
    }
    let _ = std::fs::create_dir_all(backup_dir);
    let prev = read_launchd_ollama_models().unwrap_or_else(|| "<unset>".to_string());
    let backup_path = backup_dir.join("ollama_models_backup.txt");
    std::fs::write(
        &backup_path,
        format!("previous_OLLAMA_MODELS={prev}\ntarget_OLLAMA_MODELS={library_path}\n"),
    )
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let out = command_guard::run_allowlisted(
            Path::new("/bin/launchctl"),
            &["setenv", "OLLAMA_MODELS", library_path],
        )
        .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }

    Ok(backup_path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_loopback_endpoints() {
        assert!(validate_loopback_endpoint("http://127.0.0.1:11434").is_ok());
        assert!(validate_loopback_endpoint("http://localhost:11434").is_ok());
        assert!(validate_loopback_endpoint("http://[::1]:11434").is_ok());
        assert!(validate_loopback_endpoint("http://0.0.0.0:11434").is_err());
        assert!(validate_loopback_endpoint("http://192.168.1.50:11434").is_err());
        assert!(validate_loopback_endpoint("http://169.254.169.254/latest").is_err());
    }

    #[test]
    fn parses_ollama_version_with_or_without_warning() {
        assert_eq!(
            parse_cli_version("ollama version is 0.40.9").as_deref(),
            Some("0.40.9")
        );
        assert_eq!(
            parse_cli_version(
                "Warning: could not connect to a running Ollama instance\nWarning: client version is 0.40.9"
            )
            .as_deref(),
            Some("0.40.9")
        );
    }

    #[test]
    fn configure_ollama_models_requires_confirmation_and_non_empty_path() {
        let tmp = std::env::temp_dir().join("mosaic-test-ollama-cfg");
        let err_unconfirmed = configure_ollama_models_dir("/Volumes/Drive/MOSAIC", &tmp, false)
            .expect_err("unconfirmed must fail");
        assert!(err_unconfirmed.contains("confirmation"));
        let err_empty = configure_ollama_models_dir("   ", &tmp, true)
            .expect_err("empty path must fail");
        assert!(err_empty.contains("empty"));
    }
}
