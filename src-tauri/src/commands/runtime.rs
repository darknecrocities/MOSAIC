use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::core::download_manager::DownloadRegistry;
use crate::core::inference_manager::{self, ChatStreamRequest, InferenceRegistry};
use crate::core::migration::{self, MigrationPreview, MigrationResult};
use crate::core::model_library::{self, InstalledModel, ModelShowDetails};
use crate::core::ollama_manager::{self, OllamaStatus};
use crate::core::settings_store::AppSettingsSnapshot;
use crate::core::{system_probe, telemetry, volume_manager};

pub struct RuntimeState {
    pub downloads: DownloadRegistry,
    pub inference: InferenceRegistry,
}

fn default_batches(profile: &str, ram_total: u64) -> (u32, u32) {
    match profile {
        "max_quality" => (512, 512),
        "constrained_memory" => (128, 64),
        "balanced" => (256, 128),
        _ => {
            if ram_total >= 24 * 1024_u64.pow(3) {
                (512, 512)
            } else {
                (256, 128)
            }
        }
    }
}

fn apply_adaptive_chat_defaults(
    mut req: ChatStreamRequest,
    settings: &AppSettingsSnapshot,
    system: &system_probe::SystemProfile,
) -> ChatStreamRequest {
    let profile = req
        .execution_profile
        .as_deref()
        .unwrap_or(&settings.execution_profile)
        .to_string();
    let (def_b, def_ub) = default_batches(&profile, system.ram_total_bytes);
    if req.num_ctx.is_none() {
        req.num_ctx = Some(settings.default_context_length);
    }
    if req.num_thread.is_none() {
        req.num_thread = settings
            .num_thread
            .or_else(|| system.physical_cores.map(|c| c as u32));
    }
    if req.num_batch.is_none() {
        req.num_batch = settings.num_batch.or(Some(def_b));
    }
    if req.num_ubatch.is_none() {
        req.num_ubatch = settings.num_ubatch.or(Some(def_ub));
    }
    if req.use_mmap.is_none() {
        req.use_mmap = Some(true);
    }
    if req.use_mlock.is_none() {
        req.use_mlock = Some(false);
    }
    if req.keep_alive.is_none() {
        let ka = if profile == "constrained_memory" {
            "30s".to_string()
        } else {
            settings.keep_alive.clone()
        };
        req.keep_alive = Some(ka);
    }
    req
}

#[tauri::command]
pub async fn pull_model(
    model: String,
    estimated_bytes: Option<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RuntimeState>,
) -> Result<(), String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let mut active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let live_vol = active_library
        .as_ref()
        .and_then(|lib| volume_manager::find_live_writable_volume(&volumes, &lib.volume_identifier));
    let connected = live_vol.is_some();
    if let (Some(ref mut lib), Some(vol)) = (&mut active_library, live_vol) {
        lib.free_bytes = vol.free_bytes;
        lib.total_bytes = vol.total_bytes;
    }

    runtime
        .downloads
        .start_pull(app, settings.ollama_endpoint, model.clone(), estimated_bytes, active_library, connected)
        .map_err(|e| e.to_string())?;
    let _ = telemetry::log_diagnostic(&state.store, "info", "download_manager", &format!("Started model pull for {model}"));
    Ok(())
}

#[tauri::command]
pub fn cancel_pull(
    model: String,
    state: State<'_, AppState>,
    runtime: State<'_, RuntimeState>,
) -> bool {
    let cancelled = runtime.downloads.cancel(&model);
    if cancelled {
        let _ = telemetry::log_diagnostic(&state.store, "info", "download_manager", &format!("Requested cancel for pull {model}"));
    }
    cancelled
}

#[tauri::command]
pub async fn list_installed_models(state: State<'_, AppState>) -> Result<Vec<InstalledModel>, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    model_library::list_installed_models(&settings.ollama_endpoint)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_model_details(
    model: String,
    state: State<'_, AppState>,
) -> Result<ModelShowDetails, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    model_library::show_model_details(&settings.ollama_endpoint, &model)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_installed_model(
    model: String,
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !confirmed {
        return Err("Explicit confirmation is required before deleting model weights.".into());
    }
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    model_library::delete_installed_model(&settings.ollama_endpoint, &model)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_chat_stream(
    request: ChatStreamRequest,
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, RuntimeState>,
) -> Result<(), String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let connected = active_library.as_ref().is_some_and(|lib| {
        volume_manager::find_live_writable_volume(&volumes, &lib.volume_identifier).is_some()
    });
    let system = system_probe::probe_system();
    let enriched = apply_adaptive_chat_defaults(request, &settings, &system);
    runtime
        .inference
        .start_chat(app, settings.ollama_endpoint, enriched, connected)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_chat_stream(
    state: State<'_, AppState>,
    runtime: State<'_, RuntimeState>,
) -> bool {
    let stopped = runtime.inference.stop_active();
    if stopped {
        let _ = telemetry::log_diagnostic(&state.store, "info", "inference_manager", "Stopped active chat stream");
    }
    stopped
}

#[tauri::command]
pub async fn unload_model(model: String, state: State<'_, AppState>) -> Result<(), String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    inference_manager::unload_model(&settings.ollama_endpoint, &model)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn configure_ollama_storage(
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let active_library = state
        .store
        .get_active_library()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No external library configured.".to_string())?;
    let backup_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("mosaic"));
    let backup_path = ollama_manager::configure_ollama_models_dir(
        &active_library.directory_path,
        &backup_dir,
        confirmed,
    )?;
    state
        .store
        .mark_ollama_configured(Some(&backup_path))
        .map_err(|e| e.to_string())?;
    let _ = telemetry::log_diagnostic(&state.store, "info", "ollama_manager", &format!("Configured OLLAMA_MODELS={}", active_library.directory_path));
    Ok(backup_path)
}

#[tauri::command]
pub async fn start_managed_ollama(
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<OllamaStatus, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let active_library = state
        .store
        .get_active_library()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Select an external model library before starting Ollama.".to_string())?;
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    if volume_manager::find_live_writable_volume(&volumes, &active_library.volume_identifier).is_none() {
        return Err("Selected external model library is not currently mounted and writable.".into());
    }
    let system = system_probe::probe_system();
    let status = state
        .ollama
        .start_managed(&settings.ollama_endpoint, &active_library.directory_path, &settings, &system, confirmed)
        .await?;
    let _ = state.store.mark_ollama_configured(None);
    let _ = telemetry::log_diagnostic(&state.store, "info", "ollama_supervisor", &format!("Started managed Ollama on {}", settings.ollama_endpoint));
    Ok(status)
}

#[tauri::command]
pub async fn stop_managed_ollama(
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<OllamaStatus, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let status = state
        .ollama
        .stop_managed(&settings.ollama_endpoint, confirmed)
        .await?;
    let _ = telemetry::log_diagnostic(&state.store, "info", "ollama_supervisor", "Stopped managed Ollama");
    Ok(status)
}

#[tauri::command]
pub async fn prepare_safe_eject(
    state: State<'_, AppState>,
    runtime: State<'_, RuntimeState>,
) -> Result<String, String> {
    let active_library = state
        .store
        .get_active_library()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No active external library configured.".to_string())?;
    let active_ops = runtime.downloads.has_active() || runtime.inference.is_running();
    if active_ops {
        let msg = "Stop active model downloads or inference before ejecting.".to_string();
        let _ = telemetry::log_diagnostic(&state.store, "warn", "volume_manager", &format!("Safe eject rejected: {msg}"));
        return Err(msg);
    }
    if state.ollama.stop_if_running().await {
        let _ = telemetry::log_diagnostic(
            &state.store,
            "info",
            "ollama_supervisor",
            "Stopped managed Ollama prior to external volume eject",
        );
    }
    match volume_manager::prepare_safe_eject(&active_library.mount_path, active_ops) {
        Ok(msg) => {
            let _ = telemetry::log_diagnostic(&state.store, "info", "volume_manager", &msg);
            Ok(msg)
        }
        Err(err) => {
            let msg = err.to_string();
            let _ = telemetry::log_diagnostic(&state.store, "warn", "volume_manager", &format!("Safe eject rejected: {msg}"));
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn preview_internal_migration(state: State<'_, AppState>) -> Result<MigrationPreview, String> {
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let volumes = volume_manager::list_external_volumes().unwrap_or_default();
    let live_free = active_library
        .as_ref()
        .and_then(|lib| volume_manager::find_live_writable_volume(&volumes, &lib.volume_identifier))
        .map(|v| v.free_bytes)
        .unwrap_or(0);
    Ok(migration::preview_internal_migration(live_free))
}

#[tauri::command]
pub fn execute_internal_migration(
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<MigrationResult, String> {
    let active_library = state
        .store
        .get_active_library()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Select an external model library before migrating.".to_string())?;
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let live_vol = volume_manager::find_live_writable_volume(&volumes, &active_library.volume_identifier)
        .ok_or_else(|| "Selected external model library is not currently mounted and writable.".to_string())?;
    let res = migration::copy_internal_models(
        std::path::Path::new(&active_library.directory_path),
        live_vol.free_bytes,
        confirmed,
    )?;
    let _ = telemetry::log_diagnostic(&state.store, "info", "migration", &format!("Migrated {} files ({} bytes)", res.files_copied, res.bytes_copied));
    Ok(res)
}
