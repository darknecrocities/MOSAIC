use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::security::{command_guard, SecurityError};

pub const PROTOCOL_VERSION: &str = "1.0";
const STDERR_CAP_BYTES: u64 = 64 * 1024;
const STDERR_DISPLAY_CHARS: usize = 1024;

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_resource_dir(path: PathBuf) {
    let _ = RESOURCE_DIR.set(path);
}

#[derive(Debug, Error)]
pub enum AnalyticsError {
    #[error("security violation: {0}")]
    Security(#[from] SecurityError),
    #[error("python interpreter unavailable: {0}")]
    Unavailable(String),
    #[error("analytics request timed out{0}")]
    Timeout(String),
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

pub fn candidate_python_project_dirs(
    resource_dir: Option<&Path>,
    exe_dir: Option<&Path>,
    cwd: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(res) = resource_dir {
        candidates.push(res.join("python-analytics"));
        candidates.push(res.join("resources/python-analytics"));
    }
    if let Some(exe) = exe_dir {
        candidates.push(exe.join("../Resources/python-analytics"));
        candidates.push(exe.join("../Resources/resources/python-analytics"));
        candidates.push(exe.join("python-analytics"));
        candidates.push(exe.join("resources/python-analytics"));
        candidates.push(exe.join("../lib/mosaic/python-analytics"));
        candidates.push(exe.join("../lib/MOSAIC/python-analytics"));
    }
    if let Some(dir) = cwd {
        candidates.push(dir.join("python-analytics"));
        if let Some(parent) = dir.parent() {
            candidates.push(parent.join("python-analytics"));
        }
    }
    candidates
}

pub fn locate_python_project_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(|p| p.parent());
    let cwd = std::env::current_dir().ok();
    candidate_python_project_dirs(RESOURCE_DIR.get().map(PathBuf::as_path), exe_dir, cwd.as_deref())
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
    for sys_path in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"] {
        let p = PathBuf::from(sys_path);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        let names = if cfg!(windows) {
            ["python3.exe", "python.exe"]
        } else {
            ["python3", "python"]
        };
        for dir in std::env::split_paths(&paths) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

async fn collect_stderr(task: tokio::task::JoinHandle<String>) -> String {
    match tokio::time::timeout(Duration::from_millis(250), task).await {
        Ok(Ok(s)) => {
            let trimmed = s.trim();
            if trimmed.chars().count() > STDERR_DISPLAY_CHARS {
                trimmed.chars().take(STDERR_DISPLAY_CHARS).collect()
            } else {
                trimmed.to_string()
            }
        }
        _ => String::new(),
    }
}

pub async fn run_single_job_in_dir(
    project_dir: &Path,
    python_bin: &Path,
    method: &str,
    params: serde_json::Value,
    timeout_secs: u64,
) -> Result<(PathBuf, AnalyticsEnvelope), AnalyticsError> {
    command_guard::validate_allowed_binary(python_bin)?;

    let mut child = Command::new(python_bin)
        .args(["-m", "mosaic_analytics"])
        .current_dir(project_dir)
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
    let stderr_pipe = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let Some(mut pipe) = stderr_pipe else {
            return String::new();
        };
        let mut buf = Vec::new();
        let _ = (&mut pipe).take(STDERR_CAP_BYTES).read_to_end(&mut buf).await;
        let _ = tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    let job_id = Uuid::new_v4().to_string();
    let request = serde_json::json!({
        "protocol_version": PROTOCOL_VERSION,
        "job_id": job_id,
        "method": method,
        "params": params,
    });
    let mut line =
        serde_json::to_string(&request).map_err(|e| AnalyticsError::Protocol(e.to_string()))?;
    line.push('\n');

    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await?;
    drop(stdin);

    let mut reader = BufReader::new(stdout).lines();
    let raw_resp = match tokio::time::timeout(Duration::from_secs(timeout_secs), reader.next_line()).await {
        Ok(Ok(Some(resp))) => resp,
        Ok(Ok(None)) => {
            let _ = child.wait().await;
            let err_text = collect_stderr(stderr_task).await;
            let detail = if err_text.is_empty() {
                "worker closed stdout without response".to_string()
            } else {
                format!("worker closed stdout without response; stderr: {err_text}")
            };
            return Err(AnalyticsError::Protocol(detail));
        }
        Ok(Err(e)) => {
            let _ = child.wait().await;
            let err_text = collect_stderr(stderr_task).await;
            return Err(AnalyticsError::Protocol(if err_text.is_empty() {
                e.to_string()
            } else {
                format!("{e}; stderr: {err_text}")
            }));
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let err_text = collect_stderr(stderr_task).await;
            let suffix = if err_text.is_empty() {
                String::new()
            } else {
                format!(" (stderr: {err_text})")
            };
            return Err(AnalyticsError::Timeout(suffix));
        }
    };

    let _ = child.wait().await;
    let envelope: AnalyticsEnvelope = match serde_json::from_str(&raw_resp) {
        Ok(env) => env,
        Err(e) => {
            let err_text = collect_stderr(stderr_task).await;
            let suffix = if err_text.is_empty() {
                String::new()
            } else {
                format!("; stderr: {err_text}")
            };
            return Err(AnalyticsError::Protocol(format!(
                "invalid json response: {e}{suffix}"
            )));
        }
    };
    stderr_task.abort();

    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(AnalyticsError::Protocol(format!(
            "protocol mismatch: {}",
            envelope.protocol_version
        )));
    }
    Ok((python_bin.to_path_buf(), envelope))
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
    run_single_job_in_dir(&project_dir, &python_bin, method, params, timeout_secs).await
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
