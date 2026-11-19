use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::process::{Child, Command};

use crate::core::ollama_manager::{self, OllamaStatus};
use crate::core::settings_store::AppSettingsSnapshot;
use crate::core::system_probe::SystemProfile;
use crate::security::command_guard;

const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Default)]
pub struct OllamaSupervisor {
    child: Arc<Mutex<Option<Child>>>,
}

pub fn format_ollama_host(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or("127.0.0.1");
    let port = url.port_or_known_default().unwrap_or(11434);
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

pub fn resolve_adaptive_kv_and_keep_alive(
    settings: &AppSettingsSnapshot,
    system: &SystemProfile,
) -> (&'static str, String) {
    let kv = match settings.kv_cache_type.as_str() {
        "f16" => "f16",
        "q8_0" => "q8_0",
        "q4_0" => "q4_0",
        _ => match settings.execution_profile.as_str() {
            "constrained_memory" => "q4_0",
            "balanced" => "q8_0",
            "max_quality" => "f16",
            _ => {
                if system.ram_total_bytes <= 12 * GIB || system.ram_available_bytes <= 8 * GIB {
                    "q4_0"
                } else if system.ram_total_bytes <= 24 * GIB
                    || system.ram_available_bytes <= 16 * GIB
                {
                    "q8_0"
                } else {
                    "f16"
                }
            }
        },
    };
    let keep_alive = if settings.execution_profile == "constrained_memory" {
        "30s".to_string()
    } else {
        settings.keep_alive.clone()
    };
    (kv, keep_alive)
}

pub fn compute_adaptive_ollama_env(
    endpoint: &str,
    models_dir: &str,
    settings: &AppSettingsSnapshot,
    system: &SystemProfile,
) -> Result<Vec<(&'static str, String)>, String> {
    if models_dir.trim().is_empty() {
        return Err("External library models directory cannot be empty.".into());
    }
    let url = ollama_manager::validate_loopback_endpoint(endpoint).map_err(|e| e.to_string())?;
    let host = format_ollama_host(&url);
    let (kv_type, keep_alive) = resolve_adaptive_kv_and_keep_alive(settings, system);
    Ok(vec![
        ("OLLAMA_MODELS", models_dir.to_string()),
        ("OLLAMA_HOST", host),
        ("OLLAMA_FLASH_ATTENTION", "1".to_string()),
        ("OLLAMA_KV_CACHE_TYPE", kv_type.to_string()),
        ("OLLAMA_MAX_LOADED_MODELS", settings.max_loaded_models.clamp(1, 8).to_string()),
        ("OLLAMA_NUM_PARALLEL", settings.num_parallel.clamp(1, 8).to_string()),
        ("OLLAMA_KEEP_ALIVE", keep_alive),
    ])
}

impl OllamaSupervisor {
    pub fn has_live_child(&self) -> bool {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                if matches!(child.try_wait(), Ok(None)) {
                    return true;
                }
                *guard = None;
            }
        }
        false
    }

    pub async fn start_managed(
        &self,
        endpoint: &str,
        models_dir: &str,
        settings: &AppSettingsSnapshot,
        system: &SystemProfile,
        confirmed: bool,
    ) -> Result<OllamaStatus, String> {
        if !confirmed {
            return Err("Explicit confirmation is required before starting managed Ollama.".into());
        }
        let envs = compute_adaptive_ollama_env(endpoint, models_dir, settings, system)?;
        let status = ollama_manager::inspect_ollama(Some(endpoint))
            .await
            .map_err(|e| e.to_string())?;
        if self.has_live_child() && status.api_reachable {
            return Ok(status);
        }
        if status.api_reachable {
            let configured_match = status.launchd_ollama_models.as_deref() == Some(models_dir)
                || status.env_ollama_models.as_deref() == Some(models_dir);
            if configured_match {
                return Ok(status);
            }
            return Err(format!(
                "Another Ollama instance is already running at {endpoint} without verified external OLLAMA_MODELS={models_dir}. Stop it first so weights never land on internal disk."
            ));
        }

        let bin = ollama_manager::detect_ollama_binary()
            .ok_or_else(|| "Ollama binary not found. Install Ollama before starting.".to_string())?;
        command_guard::validate_allowed_binary(&bin).map_err(|e| e.to_string())?;

        let mut cmd = Command::new(&bin);
        cmd.arg("serve")
            .envs(envs)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| format!("Failed to spawn ollama serve: {e}"))?;
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }

        let base_url = ollama_manager::validate_loopback_endpoint(endpoint).map_err(|e| e.to_string())?;
        let version_url = format!("{}/api/version", base_url.as_str().trim_end_matches('/'));
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(1))
            .build()
            .map_err(|e| e.to_string())?;

        let mut ready = false;
        for _ in 0..40 {
            if let Ok(mut guard) = self.child.lock() {
                if let Some(ch) = guard.as_mut() {
                    if let Ok(Some(exit)) = ch.try_wait() {
                        *guard = None;
                        return Err(format!("Managed ollama serve exited early with status {exit}."));
                    }
                }
            }
            if let Ok(resp) = client.get(&version_url).send().await {
                if resp.status().is_success() {
                    ready = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        if !ready {
            let _ = self.kill_child().await;
            return Err("Timed out waiting for managed Ollama /api/version readiness.".into());
        }

        ollama_manager::inspect_ollama(Some(endpoint))
            .await
            .map_err(|e| e.to_string())
    }

    async fn kill_child(&self) -> bool {
        let taken = self.child.lock().ok().and_then(|mut g| g.take());
        if let Some(mut proc_child) = taken {
            let _ = proc_child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), proc_child.wait()).await;
            return true;
        }
        false
    }

    pub async fn stop_if_running(&self) -> bool {
        if self.has_live_child() {
            return self.kill_child().await;
        }
        false
    }

    pub async fn stop_managed(&self, endpoint: &str, confirmed: bool) -> Result<OllamaStatus, String> {
        if !confirmed {
            return Err("Explicit confirmation is required before stopping managed Ollama.".into());
        }
        self.kill_child().await;
        ollama_manager::inspect_ollama(Some(endpoint))
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_adaptive_env_and_formats_ipv6_host() {
        let settings = AppSettingsSnapshot {
            execution_profile: "constrained_memory".into(),
            ..AppSettingsSnapshot::default()
        };
        let sys = crate::core::system_probe::SystemProfile {
            os_name: "Darwin".into(),
            os_version: "15".into(),
            architecture: "aarch64".into(),
            cpu_brand: "Apple M3".into(),
            physical_cores: Some(8),
            logical_cores: 8,
            ram_total_bytes: 16 * GIB,
            ram_available_bytes: 6 * GIB,
            is_unified_memory: true,
            metal_wired_limit_bytes: None,
            gpus: vec![],
            gpu_status: "unified_memory".into(),
            detected_at: "2026-11-18T00:00:00Z".into(),
        };
        let envs = compute_adaptive_ollama_env(
            "http://[::1]:11434",
            "/Volumes/OneTouch/MOSAIC/ollama-models",
            &settings,
            &sys,
        )
        .unwrap();
        assert!(envs.contains(&("OLLAMA_HOST", "[::1]:11434".into())));
        assert!(envs.contains(&("OLLAMA_FLASH_ATTENTION", "1".into())));
        assert!(envs.contains(&("OLLAMA_KV_CACHE_TYPE", "q4_0".into())));
        assert!(envs.contains(&("OLLAMA_MAX_LOADED_MODELS", "1".into())));
        assert!(envs.contains(&("OLLAMA_NUM_PARALLEL", "1".into())));
        assert!(envs.contains(&("OLLAMA_KEEP_ALIVE", "30s".into())));
    }
}
