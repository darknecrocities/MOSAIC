use serde::Serialize;
use tauri::State;

use crate::core::ollama_manager::{self, OllamaStatus};
use crate::core::python_analytics_service::{self, AnalyticsHealth};
use crate::core::settings_store::{
    ActiveLibraryRecord, AppSettingsSnapshot, DiagnosticEntry, SettingsStore,
};
use crate::core::system_probe::{self, SystemProfile};
use crate::core::telemetry::{self, ResourceTelemetry};
use crate::core::volume_manager::{self, ExternalVolume};

pub struct AppState {
    pub store: SettingsStore,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppBootstrapState {
    pub system: SystemProfile,
    pub telemetry: ResourceTelemetry,
    pub external_volumes: Vec<ExternalVolume>,
    pub active_library: Option<ActiveLibraryRecord>,
    pub library_connected: bool,
    pub ollama: OllamaStatus,
    pub analytics: AnalyticsHealth,
    pub settings: AppSettingsSnapshot,
}

#[tauri::command]
pub async fn get_app_state(state: State<'_, AppState>) -> Result<AppBootstrapState, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let system = system_probe::probe_system();
    let _ = state.store.record_device_profile(&system);
    let telemetry = telemetry::sample_resources();
    let external_volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;

    let library_connected = active_library.as_ref().is_some_and(|lib| {
        external_volumes
            .iter()
            .any(|v| v.volume_identifier == lib.volume_identifier && v.writable)
    });

    let ollama = ollama_manager::inspect_ollama(Some(&settings.ollama_endpoint))
        .await
        .map_err(|e| e.to_string())?;
    let analytics = python_analytics_service::check_health().await;

    Ok(AppBootstrapState {
        system,
        telemetry,
        external_volumes,
        active_library,
        library_connected,
        ollama,
        analytics,
        settings,
    })
}

#[tauri::command]
pub async fn select_external_library(
    volume_identifier: String,
    state: State<'_, AppState>,
) -> Result<ActiveLibraryRecord, String> {
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let selected = volumes
        .into_iter()
        .find(|v| v.volume_identifier == volume_identifier)
        .ok_or_else(|| "Selected external volume is not currently mounted.".to_string())?;

    let validation = volume_manager::validate_library_path(&selected).map_err(|e| e.to_string())?;
    let record = state
        .store
        .save_active_library(&selected, &validation)
        .map_err(|e| e.to_string())?;
    let _ = state.store.log_diagnostic(
        "info",
        "volume_manager",
        &format!("Validated external model library on {}", selected.label),
    );
    Ok(record)
}

#[tauri::command]
pub fn update_setting(
    key: String,
    value: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<AppSettingsSnapshot, String> {
    if key == "ollama_endpoint" {
        let url_str = value
            .as_str()
            .ok_or_else(|| "ollama_endpoint must be a string".to_string())?;
        ollama_manager::validate_loopback_endpoint(url_str).map_err(|e| e.to_string())?;
    }
    state
        .store
        .set_setting(&key, &value)
        .map_err(|e| e.to_string())?;
    state.store.get_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_diagnostics(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<DiagnosticEntry>, String> {
    state
        .store
        .list_diagnostics(limit.unwrap_or(50).min(200))
        .map_err(|e| e.to_string())
}
