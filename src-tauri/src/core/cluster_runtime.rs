use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::process::{Child, Command};

use crate::core::cluster_flags::{validate_gguf_path, validate_llama_extra_flags};
use crate::security::command_guard;

#[derive(Default)]
pub struct ClusterRuntimeRegistry {
    child: Arc<Mutex<Option<Child>>>,
}

impl ClusterRuntimeRegistry {
    pub fn is_running(&self) -> bool {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(ch) = guard.as_mut() {
                if matches!(ch.try_wait(), Ok(None)) {
                    return true;
                }
                *guard = None;
            }
        }
        false
    }

    pub fn track_child(&self, child: Child) {
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }
    }

    pub fn stop(&self) -> bool {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut proc_child) = guard.take() {
                let _ = proc_child.start_kill();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move {
                        let _ = proc_child.wait().await;
                    });
                } else {
                    let _ = proc_child.try_wait();
                }
                return true;
            }
        }
        false
    }

    async fn stop_and_wait(&self) {
        let taken = self.child.lock().ok().and_then(|mut g| g.take());
        if let Some(mut proc_child) = taken {
            let _ = proc_child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), proc_child.wait()).await;
            for _ in 0..20 {
                if TcpStream::connect("127.0.0.1:11435").await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }

    pub async fn launch_llama_server(
        &self,
        library_root: &Path,
        gguf_rel_path: &str,
        extra_flags: &[String],
        confirmed: bool,
    ) -> Result<String, String> {
        if !confirmed {
            return Err("Explicit confirmation required before launching llama-server.".into());
        }
        let model_path = validate_gguf_path(library_root, gguf_rel_path)?;
        let safe_flags = validate_llama_extra_flags(extra_flags)?;

        let bin = [
            "/opt/homebrew/bin/llama-server",
            "/usr/local/bin/llama-server",
            "/usr/bin/llama-server",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .ok_or_else(|| {
            "llama-server binary not found. Install llama.cpp to launch experimental MoE/RPC mode.".to_string()
        })?;
        command_guard::validate_allowed_binary(&bin).map_err(|e| e.to_string())?;

        self.stop_and_wait().await;
        let mut cmd = Command::new(&bin);
        cmd.arg("-m")
            .arg(&model_path)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("11435")
            .args(&safe_flags)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        match child.try_wait() {
            Ok(Some(status)) => Err(format!("llama-server exited immediately with status {status}.")),
            Ok(None) => {
                self.track_child(child);
                Ok("Experimental llama-server started on http://127.0.0.1:11435".into())
            }
            Err(e) => Err(format!("Failed to inspect llama-server process state: {e}")),
        }
    }
}
