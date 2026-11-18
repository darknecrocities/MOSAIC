use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use uuid::Uuid;

pub use crate::core::cluster_flags::{
    scan_gguf_files, validate_gguf_path, validate_llama_extra_flags, validate_worker_host,
};
use crate::core::model_catalog::CatalogModelEntry;
use crate::core::python_analytics_service;
use crate::core::settings_store::{SettingsStore, StoreError};
use crate::core::system_probe::{self, SystemProfile};
use crate::security::command_guard;

#[derive(Debug, Error)]
pub enum ClusterError {
    #[error("storage error: {0}")]
    Store(#[from] StoreError),
    #[error("worker host rejected by SSRF/LAN policy: {0}")]
    InvalidHost(String),
    #[error("port must be between 1024 and 65535")]
    InvalidPort,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterWorker {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub vram_bytes: u64,
    pub ram_available_bytes: u64,
    pub backend: String,
    pub status: String,
    pub rtt_ms: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAllocation {
    pub name: String,
    pub role: String,
    pub endpoint: String,
    pub allocated_bytes: u64,
    pub budget_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterPlan {
    pub strategy: String,
    pub feasible: bool,
    pub is_moe: bool,
    pub total_demand_bytes: u64,
    pub tier1_gpu_bytes: u64,
    pub tier2_ram_bytes: u64,
    pub tier3_disk_mmap_bytes: u64,
    pub node_allocations: Vec<NodeAllocation>,
    pub runtime_flags: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn list_workers(store: &SettingsStore) -> Result<Vec<ClusterWorker>, ClusterError> {
    store
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, host, port, vram_bytes, ram_available_bytes,
                        backend, status, rtt_ms, created_at
                 FROM cluster_workers ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ClusterWorker {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get::<_, i64>(3)? as u16,
                    vram_bytes: row.get::<_, i64>(4)? as u64,
                    ram_available_bytes: row.get::<_, i64>(5)? as u64,
                    backend: row.get(6)?,
                    status: row.get(7)?,
                    rtt_ms: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub fn add_worker(
    store: &SettingsStore,
    name: &str,
    host: &str,
    port: u16,
    vram_bytes: u64,
    ram_available_bytes: u64,
    backend: &str,
    allow_lan: bool,
) -> Result<ClusterWorker, ClusterError> {
    validate_worker_host(host, allow_lan)?;
    if port < 1024 {
        return Err(ClusterError::InvalidPort);
    }
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let clean_name = name.trim().to_string();
    let clean_host = host.trim().to_string();
    let clean_backend = backend.trim().to_string();

    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO cluster_workers (
                id, name, host, port, vram_bytes, ram_available_bytes,
                backend, status, rtt_ms, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'configured', NULL, ?8)
             ON CONFLICT(host, port) DO UPDATE SET
                name = excluded.name,
                vram_bytes = excluded.vram_bytes,
                ram_available_bytes = excluded.ram_available_bytes,
                backend = excluded.backend",
            params![
                id,
                clean_name,
                clean_host,
                i64::from(port),
                vram_bytes as i64,
                ram_available_bytes as i64,
                clean_backend,
                now,
            ],
        )?;
        Ok(())
    })?;

    Ok(ClusterWorker {
        id,
        name: clean_name,
        host: clean_host,
        port,
        vram_bytes,
        ram_available_bytes,
        backend: clean_backend,
        status: "configured".to_string(),
        rtt_ms: None,
        created_at: now,
    })
}

pub fn remove_worker(store: &SettingsStore, id: &str) -> Result<(), ClusterError> {
    store
        .with_conn(|conn| {
            conn.execute("DELETE FROM cluster_workers WHERE id = ?1", params![id])?;
            Ok(())
        })
        .map_err(Into::into)
}

pub async fn probe_workers(store: &SettingsStore) -> Result<Vec<ClusterWorker>, ClusterError> {
    let workers = list_workers(store)?;
    for w in &workers {
        let addr = format!("{}:{}", w.host, w.port);
        let started = std::time::Instant::now();
        let (status, rtt_ms) =
            match tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(&addr)).await {
                Ok(Ok(_)) => {
                    let ms = (started.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
                    ("reachable", Some(ms))
                }
                _ => ("unreachable", None),
            };
        let _ = store.with_conn(|conn| {
            conn.execute(
                "UPDATE cluster_workers SET status = ?1, rtt_ms = ?2 WHERE id = ?3",
                params![status, rtt_ms, w.id],
            )?;
            Ok(())
        });
    }
    list_workers(store)
}

pub async fn compute_cluster_plan(
    model: &CatalogModelEntry,
    system: &SystemProfile,
    workers: &[ClusterWorker],
    context_length: u32,
    safety_reserve_gib: f64,
    media_kind: Option<&str>,
) -> Result<ClusterPlan, String> {
    let vram_bytes = system_probe::primary_gpu_vram_bytes(system);
    let params = serde_json::json!({
        "model": model,
        "local_node": {
            "name": system.cpu_brand,
            "is_unified_memory": system.is_unified_memory,
            "vram_bytes": vram_bytes,
            "ram_total_bytes": system.ram_total_bytes,
            "ram_available_bytes": system.ram_available_bytes,
            "metal_wired_limit_bytes": system.metal_wired_limit_bytes,
        },
        "workers": workers,
        "storage": { "media_kind": media_kind.unwrap_or("unknown") },
        "context_length": context_length,
        "safety_reserve_gib": safety_reserve_gib,
    });

    let (_, env) = python_analytics_service::run_single_job("plan_cluster", params, 6)
        .await
        .map_err(|e| e.to_string())?;
    if env.kind == "error" {
        return Err(env.payload["error"]["message"]
            .as_str()
            .unwrap_or("Cluster planning failed")
            .to_string());
    }
    serde_json::from_value::<ClusterPlan>(env.payload["value"].clone())
        .map_err(|e| format!("invalid cluster plan payload: {e}"))
}

#[derive(Default)]
pub struct ClusterRuntimeRegistry {
    child: Arc<Mutex<Option<Child>>>,
}

impl ClusterRuntimeRegistry {
    pub fn stop(&self) -> bool {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut proc_child) = guard.take() {
                let _ = proc_child.start_kill();
                return true;
            }
        }
        false
    }

    pub fn launch_llama_server(
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

        self.stop();
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
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }
        Ok("Experimental llama-server started on http://127.0.0.1:11435".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_metadata_and_requires_opt_in_for_lan() {
        assert!(validate_worker_host("127.0.0.1", false).is_ok());
        assert!(validate_worker_host("192.168.1.20", false).is_err());
        assert!(validate_worker_host("192.168.1.20", true).is_ok());
        assert!(validate_worker_host("169.254.169.254", true).is_err());
    }

    #[test]
    fn worker_crud_roundtrip() {
        let store = SettingsStore::open_in_memory().unwrap();
        let w = add_worker(
            &store, "RTX-Worker", "127.0.0.1", 50052,
            24 * 1024_u64.pow(3), 16 * 1024_u64.pow(3), "cuda", false,
        )
        .unwrap();
        assert_eq!(list_workers(&store).unwrap().len(), 1);
        remove_worker(&store, &w.id).unwrap();
        assert!(list_workers(&store).unwrap().is_empty());
    }
}
