use serde::Deserialize;
use tauri::State;

use crate::commands::AppState;
use crate::core::cluster_manager::{self, ClusterPlan, ClusterRuntimeRegistry, ClusterWorker};
use crate::core::{model_catalog, system_probe, telemetry};

#[derive(Debug, Deserialize)]
pub struct AddWorkerRequest {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub vram_gib: f64,
    pub ram_gib: f64,
    pub backend: String,
    pub allow_lan: bool,
}

#[tauri::command]
pub fn list_cluster_workers(state: State<'_, AppState>) -> Result<Vec<ClusterWorker>, String> {
    cluster_manager::list_workers(&state.store).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_cluster_worker(
    request: AddWorkerRequest,
    state: State<'_, AppState>,
) -> Result<ClusterWorker, String> {
    let gib = 1024_f64.powi(3);
    cluster_manager::add_worker(
        &state.store,
        &request.name,
        &request.host,
        request.port,
        (request.vram_gib.max(0.0) * gib) as u64,
        (request.ram_gib.max(0.0) * gib) as u64,
        &request.backend,
        request.allow_lan,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_cluster_worker(id: String, state: State<'_, AppState>) -> Result<(), String> {
    cluster_manager::remove_worker(&state.store, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn probe_cluster_workers(
    state: State<'_, AppState>,
) -> Result<Vec<ClusterWorker>, String> {
    cluster_manager::probe_workers(&state.store)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plan_adaptive_execution(
    ollama_name: String,
    context_length: Option<u32>,
    state: State<'_, AppState>,
) -> Result<ClusterPlan, String> {
    let catalog = model_catalog::load_effective_catalog(Some(&state.store));
    let model = catalog
        .into_iter()
        .find(|m| m.ollama_name == ollama_name)
        .ok_or_else(|| format!("Model '{ollama_name}' not found in catalog"))?;

    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let workers = cluster_manager::list_workers(&state.store).map_err(|e| e.to_string())?;
    let system = system_probe::probe_system();
    let media_kind = active_library.as_ref().map(|l| l.media_kind.as_str());

    cluster_manager::compute_cluster_plan(
        &model,
        &system,
        &workers,
        context_length.unwrap_or(settings.default_context_length),
        settings.safety_reserve_gib,
        media_kind,
    )
    .await
}

#[tauri::command]
pub fn launch_cluster_runtime(
    gguf_rel_path: String,
    runtime_flags: Vec<String>,
    confirmed: bool,
    state: State<'_, AppState>,
    cluster_rt: State<'_, ClusterRuntimeRegistry>,
) -> Result<String, String> {
    let active_library = state
        .store
        .get_active_library()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "External model library required before launching cluster runtime.".to_string())?;
    match cluster_rt.launch_llama_server(
        std::path::Path::new(&active_library.directory_path),
        &gguf_rel_path,
        &runtime_flags,
        confirmed,
    ) {
        Ok(msg) => {
            let _ = telemetry::log_diagnostic(&state.store, "info", "cluster_manager", &msg);
            Ok(msg)
        }
        Err(err) => {
            let _ = telemetry::log_diagnostic(&state.store, "error", "cluster_manager", &format!("Cluster launch failed: {err}"));
            Err(err)
        }
    }
}

#[tauri::command]
pub fn stop_cluster_runtime(
    state: State<'_, AppState>,
    cluster_rt: State<'_, ClusterRuntimeRegistry>,
) -> bool {
    let stopped = cluster_rt.stop();
    if stopped {
        let _ = telemetry::log_diagnostic(&state.store, "info", "cluster_manager", "Stopped experimental llama-server");
    }
    stopped
}
