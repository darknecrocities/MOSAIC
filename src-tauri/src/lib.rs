pub mod core;
pub mod security;

use serde::Serialize;

use crate::core::ollama_manager::{self, OllamaStatus};
use crate::core::python_analytics_service::{self, AnalyticsHealth};
use crate::core::system_probe::{self, SystemProfile};
use crate::core::volume_manager::{self, ExternalVolume};

#[derive(Debug, Clone, Serialize)]
pub struct SpikeReport {
    pub system: SystemProfile,
    pub external_volumes: Vec<ExternalVolume>,
    pub ollama: OllamaStatus,
    pub analytics: AnalyticsHealth,
}

#[tauri::command]
async fn get_spike_diagnostics() -> Result<SpikeReport, String> {
    let system = system_probe::probe_system();
    let external_volumes =
        volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let ollama = ollama_manager::inspect_ollama(None)
        .await
        .map_err(|e| e.to_string())?;
    let analytics = python_analytics_service::check_health().await;

    Ok(SpikeReport {
        system,
        external_volumes,
        ollama,
        analytics,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mosaic=info".into()),
        )
        .json()
        .init();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_spike_diagnostics])
        .run(tauri::generate_context!())
        .expect("error while running MOSAIC Tauri application");
}
