use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::core::benchmark_store::{self, BenchmarkInput, BenchmarkReportRecord};
use crate::core::python_analytics_service;
use crate::core::volume_manager;
use crate::security::command_guard;

#[derive(Debug, Clone, Serialize)]
pub struct ExportedReport {
    pub format: String,
    pub content: String,
}

#[tauri::command]
pub async fn run_model_benchmark(
    model: String,
    context_length: Option<u32>,
    repetitions: Option<u32>,
    state: State<'_, AppState>,
) -> Result<BenchmarkReportRecord, String> {
    command_guard::validate_model_name(&model).map_err(|e| e.to_string())?;
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let connected = active_library.as_ref().is_some_and(|lib| {
        volumes
            .iter()
            .any(|v| v.volume_identifier == lib.volume_identifier && v.writable)
    });
    if !connected {
        return Err("External model library must be connected before benchmarking.".into());
    }

    let ctx = context_length.unwrap_or(4096).clamp(512, 32_768);
    let reps = repetitions.unwrap_or(2).clamp(2, 5);
    let media_kind = active_library
        .map(|l| l.media_kind)
        .unwrap_or_else(|| "unknown".into());

    let params = serde_json::json!({
        "endpoint": settings.ollama_endpoint,
        "model": model,
        "context_length": ctx,
        "repetitions": reps,
        "cold_load_timeout_s": 180.0,
    });

    let (_, env) = python_analytics_service::run_single_job("run_benchmark", params, 360)
        .await
        .map_err(|e| e.to_string())?;
    if env.kind == "error" {
        return Err(env.payload["error"]["message"]
            .as_str()
            .unwrap_or("Benchmark failed")
            .to_string());
    }

    let val = &env.payload["value"];
    let input = BenchmarkInput {
        model_name: model,
        context_length: ctx,
        storage_media_kind: media_kind,
        cold_load_ms: val["cold_load_ms"].as_f64(),
        warm_load_ms: val["warm_load_ms"]["median"].as_f64(),
        ttft_median_ms: val["ttft_ms"]["median"].as_f64(),
        tok_per_sec_median: val["generation_tok_per_sec"]["median"].as_f64(),
        peak_ram_bytes: val["peak_ram_used_bytes"].as_u64(),
        repetitions: reps,
        raw_report_json: serde_json::to_string(val).unwrap_or_else(|_| "{}".into()),
    };

    benchmark_store::save_benchmark_report(&state.store, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_benchmark_reports(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<BenchmarkReportRecord>, String> {
    benchmark_store::list_benchmark_reports(&state.store, limit.unwrap_or(20).min(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_benchmark_report(
    report_id: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<ExportedReport, String> {
    let report = benchmark_store::get_benchmark_report(&state.store, &report_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Benchmark report not found.".to_string())?;

    let report_val: serde_json::Value =
        serde_json::from_str(&report.raw_report_json).unwrap_or_else(|_| serde_json::json!({}));
    let (_, env) = python_analytics_service::run_single_job(
        "export_report",
        serde_json::json!({ "format": format, "report": report_val }),
        10,
    )
    .await
    .map_err(|e| e.to_string())?;

    let val = &env.payload["value"];
    Ok(ExportedReport {
        format: val["format"].as_str().unwrap_or(&format).to_string(),
        content: val["content"].as_str().unwrap_or("").to_string(),
    })
}
