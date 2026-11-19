pub mod benchmark_helpers;
pub mod benchmarks;
pub mod cluster;
pub mod runtime;
pub mod runtime_state;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::model_catalog::{self, CatalogModelWithFit};
use crate::core::ollama_manager::{self, OllamaStatus};
use crate::core::ollama_supervisor::OllamaSupervisor;
use crate::core::python_analytics_service::{self, AnalyticsHealth};
use crate::core::settings_store::{ActiveLibraryRecord, AppSettingsSnapshot, SettingsStore};
use crate::core::system_probe::{self, SystemProfile};
use crate::core::telemetry::{self, DiagnosticEntry, ResourceTelemetry};
use crate::core::volume_manager::{self, ExternalVolume};

pub struct AppState {
    pub store: SettingsStore,
    pub ollama: OllamaSupervisor,
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

#[derive(Debug, Clone, Serialize)]
pub struct CatalogRefreshResult {
    pub count: usize,
    pub source_url: String,
    pub refreshed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareAnalysisReport {
    pub os: serde_json::Value,
    pub cpu: serde_json::Value,
    pub memory: serde_json::Value,
    pub ram_effective_avail_bytes: u64,
    #[serde(default)]
    pub metal_wired_limit_bytes: Option<u64>,
    #[serde(default)]
    pub gpu_devices: Vec<serde_json::Value>,
    pub gpu: serde_json::Value,
    #[serde(default)]
    pub limitations: Vec<String>,
    #[serde(default)]
    pub confidence: String,
    #[serde(default)]
    pub source: String,
}

#[tauri::command]
pub fn get_telemetry() -> ResourceTelemetry {
    telemetry::sample_resources()
}

#[tauri::command]
pub async fn get_app_state(state: State<'_, AppState>) -> Result<AppBootstrapState, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let system = system_probe::probe_system();
    let _ = state.store.record_device_profile(&system);
    let telemetry = telemetry::sample_resources();
    let external_volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let mut active_library = state.store.get_active_library().map_err(|e| e.to_string())?;

    let mut library_connected = false;
    if let Some(ref mut lib) = active_library {
        if let Some(live) = volume_manager::find_live_writable_volume(&external_volumes, &lib.volume_identifier) {
            lib.free_bytes = live.free_bytes;
            lib.total_bytes = live.total_bytes;
            library_connected = true;
        }
    }

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
    let _ = telemetry::log_diagnostic(
        &state.store,
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
    telemetry::list_diagnostics(&state.store, limit.unwrap_or(50).min(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_catalog_with_fit(
    context_length: Option<u32>,
    execution_profile: Option<String>,
    kv_cache_type: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<CatalogModelWithFit>, String> {
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let system = system_probe::probe_system();
    let media_kind = active_library.as_ref().map(|lib| lib.media_kind.as_str());
    let ctx = context_length
        .unwrap_or(settings.default_context_length)
        .clamp(512, 131_072);
    let profile = execution_profile.unwrap_or(settings.execution_profile);
    let kv = kv_cache_type.or_else(|| {
        if settings.kv_cache_type == "auto" {
            None
        } else {
            Some(settings.kv_cache_type)
        }
    });
    let entries = model_catalog::load_effective_catalog(Some(&state.store));

    Ok(model_catalog::evaluate_catalog(
        entries,
        &system,
        ctx,
        settings.safety_reserve_gib,
        media_kind,
        Some(&profile),
        kv.as_deref(),
    )
    .await)
}

#[tauri::command]
pub async fn refresh_model_catalog(
    url: Option<String>,
    state: State<'_, AppState>,
) -> Result<CatalogRefreshResult, String> {
    let target = url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(model_catalog::DEFAULT_CATALOG_REFRESH_URL);
    let entries = model_catalog::refresh_catalog_https(target).await?;
    let json = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
    state
        .store
        .save_catalog_snapshot_json(&json)
        .map_err(|e| e.to_string())?;
    let count = entries.len();
    let _ = telemetry::log_diagnostic(
        &state.store,
        "info",
        "model_catalog",
        &format!("Refreshed catalog snapshot ({count} models) from {target}"),
    );
    Ok(CatalogRefreshResult {
        count,
        source_url: target.to_string(),
        refreshed_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn analyze_hardware_insights(
    state: State<'_, AppState>,
) -> Result<HardwareAnalysisReport, String> {
    let system = system_probe::probe_system();
    let (_, env) = python_analytics_service::run_single_job(
        "analyze_hardware",
        serde_json::json!({ "system_profile": system }),
        8,
    )
    .await
    .map_err(|e| e.to_string())?;
    if env.kind == "error" {
        let msg = env.payload["error"]["message"]
            .as_str()
            .unwrap_or("Hardware analysis failed")
            .to_string();
        let _ = telemetry::log_diagnostic(&state.store, "error", "hardware_analyzer", &msg);
        return Err(msg);
    }
    let mut val = env.payload["value"].clone();
    if let Some(obj) = val.as_object_mut() {
        obj.insert("limitations".into(), env.payload["limitations"].clone());
        obj.insert("confidence".into(), env.payload["confidence"].clone());
        obj.insert("source".into(), env.payload["source"].clone());
    }
    serde_json::from_value::<HardwareAnalysisReport>(val)
        .map_err(|e| format!("Invalid hardware analysis payload: {e}"))
}
