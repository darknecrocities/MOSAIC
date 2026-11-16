use mosaic_lib::core::{ollama_manager, python_analytics_service, system_probe, volume_manager};
use serde_json::json;

#[tokio::main]
async fn main() {
    let system = system_probe::probe_system();
    let volumes = volume_manager::list_external_volumes().unwrap_or_default();
    let ollama = ollama_manager::inspect_ollama(None).await.ok();
    let analytics_health = python_analytics_service::check_health().await;
    let analytics_hw = python_analytics_service::run_single_job("analyze_hardware", json!({}), 5)
        .await
        .ok()
        .map(|(_, env)| env);

    let report = json!({
        "milestone": "A-spikes",
        "system_probe": system,
        "external_volumes": volumes,
        "ollama": ollama,
        "analytics_health": analytics_health,
        "analytics_hardware": analytics_hw,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
