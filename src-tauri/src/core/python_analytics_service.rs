use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::security::{command_guard, SecurityError};

pub const PROTOCOL_VERSION: &str = "1.0";

#[derive(Debug, Error)]
pub enum AnalyticsError {
    #[error("security violation: {0}")]
    Security(#[from] SecurityError),
    #[error("python interpreter unavailable: {0}")]
    Unavailable(String),
    #[error("analytics request timed out")]
    Timeout,
    #[error("protocol mismatch or invalid response: {0}")]
    Protocol(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticsEnvelope {
    pub protocol_version: String,
    pub job_id: String,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticsHealth {
    pub available: bool,
    pub python_path: Option<String>,
    pub protocol_version: Option<String>,
    pub service_version: Option<String>,
    pub error: Option<String>,
}

pub fn locate_python_project_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // macOS .app/Contents/Resources/python-analytics
            candidates.push(exe_dir.join("../Resources/python-analytics"));
            // Windows/Linux bundled resources
            candidates.push(exe_dir.join("resources/python-analytics"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("python-analytics"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("python-analytics"));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.join("pyproject.toml").is_file())
}

pub fn locate_python_binary(project_dir: &Path) -> Option<PathBuf> {
    let venv_unix = project_dir.join(".venv").join("bin").join("python3");
    if venv_unix.is_file() {
        return Some(venv_unix);
    }
    let venv_win = project_dir.join(".venv").join("Scripts").join("python.exe");
    if venv_win.is_file() {
        return Some(venv_win);
    }
    let system_candidates = ["/opt/homebrew/bin/python3", "/usr/bin/python3"];
    system_candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

pub async fn run_single_job(
    method: &str,
    params: serde_json::Value,
    timeout_secs: u64,
) -> Result<(PathBuf, AnalyticsEnvelope), AnalyticsError> {
    let project_dir = locate_python_project_dir()
        .ok_or_else(|| AnalyticsError::Unavailable("python-analytics directory not found".into()))?;
    let python_bin = locate_python_binary(&project_dir)
        .ok_or_else(|| AnalyticsError::Unavailable("python3 runtime not found".into()))?;

    command_guard::validate_allowed_binary(&python_bin)?;

    let mut child = Command::new(&python_bin)
        .args(["-m", "mosaic_analytics"])
        .current_dir(&project_dir)
        .env("PYTHONPATH", project_dir.join("src"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AnalyticsError::Protocol("missing child stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AnalyticsError::Protocol("missing child stdout".into()))?;

    let job_id = Uuid::new_v4().to_string();
    let request = serde_json::json!({
        "protocol_version": PROTOCOL_VERSION,
        "job_id": job_id,
        "method": method,
        "params": params,
    });
    let mut line = serde_json::to_string(&request)
        .map_err(|e| AnalyticsError::Protocol(e.to_string()))?;
    line.push('\n');

    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await?;
    drop(stdin);

    let mut reader = BufReader::new(stdout).lines();
    let read_fut = reader.next_line();
    let raw_resp = tokio::time::timeout(Duration::from_secs(timeout_secs), read_fut)
        .await
        .map_err(|_| AnalyticsError::Timeout)?
        .map_err(AnalyticsError::Io)?
        .ok_or_else(|| AnalyticsError::Protocol("worker closed stdout without response".into()))?;

    let _ = child.wait().await;
    let envelope: AnalyticsEnvelope = serde_json::from_str(&raw_resp)
        .map_err(|e| AnalyticsError::Protocol(format!("invalid json response: {e}")))?;

    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(AnalyticsError::Protocol(format!(
            "protocol mismatch: {}",
            envelope.protocol_version
        )));
    }
    Ok((python_bin, envelope))
}

pub async fn check_health() -> AnalyticsHealth {
    match run_single_job("ping", serde_json::json!({}), 5).await {
        Ok((bin, env)) => {
            let val = env.payload.get("value");
            let svc_ver = val
                .and_then(|v| v.get("version"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            AnalyticsHealth {
                available: env.kind == "pong",
                python_path: Some(bin.display().to_string()),
                protocol_version: Some(env.protocol_version),
                service_version: svc_ver,
                error: None,
            }
        }
        Err(err) => AnalyticsHealth {
            available: false,
            python_path: None,
            protocol_version: None,
            service_version: None,
            error: Some(err.to_string()),
        },
    }
}
