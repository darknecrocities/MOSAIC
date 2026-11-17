use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::core::download_manager::DownloadRegistry;
use crate::core::inference_manager::{self, ChatStreamRequest, InferenceRegistry};
use crate::core::migration::{self, MigrationPreview, MigrationResult};
use crate::core::model_library::{self, InstalledModel};
use crate::core::ollama_manager;
use crate::core::volume_manager;

pub struct RuntimeState {
    pub downloads: DownloadRegistry,
    pub inference: InferenceRegistry,
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
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let connected = active_library.as_ref().is_some_and(|lib| {
        volumes
            .iter()
            .any(|v| v.volume_identifier == lib.volume_identifier && v.writable)
    });

    runtime
        .downloads
        .start_pull(
            app,
            settings.ollama_endpoint,
            model,
            estimated_bytes,
            active_library,
            connected,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_pull(model: String, runtime: State<'_, RuntimeState>) -> bool {
    runtime.downloads.cancel(&model)
}

#[tauri::command]
pub async fn list_installed_models(state: State<'_, AppState>) -> Result<Vec<InstalledModel>, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    model_library::list_installed_models(&settings.ollama_endpoint)
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
        volumes
            .iter()
            .any(|v| v.volume_identifier == lib.volume_identifier && v.writable)
    });

    runtime
        .inference
        .start_chat(app, settings.ollama_endpoint, request, connected)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_chat_stream(runtime: State<'_, RuntimeState>) -> bool {
    runtime.inference.stop_active()
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
    ollama_manager::configure_ollama_models_dir(
        &active_library.directory_path,
        &backup_dir,
        confirmed,
    )
}

#[tauri::command]
pub fn prepare_safe_eject(
    state: State<'_, AppState>,
    runtime: State<'_, RuntimeState>,
) -> Result<String, String> {
    let active_library = state
        .store
        .get_active_library()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No active external library configured.".to_string())?;
    let active_ops = runtime.downloads.has_active() || runtime.inference.is_running();
    volume_manager::prepare_safe_eject(&active_library.mount_path, active_ops)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn preview_internal_migration(state: State<'_, AppState>) -> Result<MigrationPreview, String> {
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let free = active_library.map(|l| l.free_bytes).unwrap_or(0);
    Ok(migration::preview_internal_migration(free))
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
    migration::copy_internal_models(
        std::path::Path::new(&active_library.directory_path),
        active_library.free_bytes,
        confirmed,
    )
}
