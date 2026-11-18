use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::core::benchmark_store::{self, BenchmarkInput, BenchmarkReportRecord};
use crate::core::{
    model_library, ollama_manager, python_analytics_service, system_probe, telemetry, volume_manager,
};
use crate::security::command_guard;

#[derive(Debug, Clone, Serialize)]
pub struct ExportedReport {
    pub format: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceAnalysisReport {
    pub bottlenecks: Vec<serde_json::Value>,
    pub efficiency_ratios: serde_json::Value,
    pub recommendations: Vec<String>,
    pub summary: String,
    #[serde(default)]
    pub confidence: String,
    #[serde(default)]
    pub limitations: Vec<String>,
}

fn default_benchmark_options(
    profile: &str,
    ctx: u32,
    settings: &crate::core::settings_store::AppSettingsSnapshot,
    system: &system_probe::SystemProfile,
) -> serde_json::Value {
    let (def_b, def_ub) = match profile {
        "max_quality" => (512_u32, 512_u32),
        "constrained_memory" => (128, 64),
        "balanced" => (256, 128),
        _ => {
            if system.ram_total_bytes >= 24 * 1024_u64.pow(3) {
                (512, 512)
            } else {
                (256, 128)
            }
        }
    };
    let threads = settings
        .num_thread
        .or_else(|| system.physical_cores.map(|c| c as u32))
        .unwrap_or(4);
    serde_json::json!({
        "num_ctx": ctx,
        "num_batch": settings.num_batch.unwrap_or(def_b),
        "num_ubatch": settings.num_ubatch.unwrap_or(def_ub),
        "num_thread": threads,
        "use_mmap": true,
        "use_mlock": false,
    })
}

fn compute_job_timeout_s(
    cold_load_timeout_s: Option<f64>,
    model_size_bytes: Option<u64>,
    media_kind: &str,
    reps: u32,
) -> (f64, u64) {
    let cold_s = if let Some(explicit) = cold_load_timeout_s.filter(|v| v.is_finite() && *v > 0.0) {
        explicit.max(30.0)
    } else if let Some(sz) = model_size_bytes.filter(|v| *v > 0) {
        let rate_bps = if media_kind.eq_ignore_ascii_case("SSD") || media_kind.eq_ignore_ascii_case("NVME") {
            250.0 * 1024.0 * 1024.0
        } else {
            60.0 * 1024.0 * 1024.0
        };
        (((sz as f64) / rate_bps) * 1.5 + 60.0).clamp(180.0, 900.0)
    } else {
        180.0
    };
    let job_timeout = ((cold_s as u64) + u64::from(reps) * 120 + 60).clamp(360, 2400);
    (cold_s, job_timeout)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_model_benchmark(
    model: String,
    context_length: Option<u32>,
    repetitions: Option<u32>,
    cold_load_timeout_s: Option<f64>,
    execution_profile: Option<String>,
    kv_cache_type: Option<String>,
    options: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<BenchmarkReportRecord, String> {
    command_guard::validate_model_name(&model).map_err(|e| e.to_string())?;
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let active_library = state.store.get_active_library().map_err(|e| e.to_string())?;
    let volumes = volume_manager::list_external_volumes().map_err(|e| e.to_string())?;
    let connected = active_library.as_ref().is_some_and(|lib| {
        volume_manager::find_live_writable_volume(&volumes, &lib.volume_identifier).is_some()
    });
    if !connected {
        return Err("External model library must be connected before benchmarking.".into());
    }

    let ctx = context_length
        .unwrap_or(settings.default_context_length)
        .clamp(512, 131_072);
    let reps = repetitions.unwrap_or(2).clamp(2, 5);
    let media_kind = active_library
        .as_ref()
        .map(|l| l.media_kind.clone())
        .unwrap_or_else(|| "unknown".into());
    let profile = execution_profile.unwrap_or_else(|| settings.execution_profile.clone());
    let system = system_probe::probe_system();

    let installed = model_library::list_installed_models(&settings.ollama_endpoint)
        .await
        .ok()
        .and_then(|list| list.into_iter().find(|m| m.name == model));
    let model_size_bytes = installed.as_ref().map(|m| m.size_bytes);
    let model_digest = installed.as_ref().map(|m| m.digest.clone());
    let quantization = installed.as_ref().and_then(|m| m.quantization_level.clone());
    let ollama_version = ollama_manager::inspect_ollama(Some(&settings.ollama_endpoint))
        .await
        .ok()
        .and_then(|s| s.api_version.or(s.cli_version));

    let effective_opts = options.unwrap_or_else(|| default_batches_opts(&profile, ctx, &settings, &system));
    let (cold_s, job_timeout_s) = compute_job_timeout_s(cold_load_timeout_s, model_size_bytes, &media_kind, reps);

    let _ = telemetry::log_diagnostic(
        &state.store,
        "info",
        "benchmark",
        &format!("Started benchmark for {model} (ctx={ctx}, reps={reps}, profile={profile})"),
    );

    let params = serde_json::json!({
        "endpoint": settings.ollama_endpoint,
        "model": model,
        "context_length": ctx,
        "repetitions": reps,
        "cold_load_timeout_s": cold_s,
        "model_size_bytes": model_size_bytes,
        "media_kind": media_kind,
        "execution_profile": profile,
        "kv_cache_type": kv_cache_type.unwrap_or_else(|| settings.kv_cache_type.clone()),
        "options": effective_opts,
        "keep_alive": settings.keep_alive,
    });

    let (_, env) = python_analytics_service::run_single_job("run_benchmark", params, job_timeout_s)
        .await
        .map_err(|e| {
            let _ = telemetry::log_diagnostic(&state.store, "error", "benchmark", &format!("Benchmark error for {model}: {e}"));
            e.to_string()
        })?;
    if env.kind == "error" {
        let msg = env.payload["error"]["message"]
            .as_str()
            .unwrap_or("Benchmark failed")
            .to_string();
        let _ = telemetry::log_diagnostic(&state.store, "error", "benchmark", &format!("Benchmark failed for {model}: {msg}"));
        return Err(msg);
    }

    let val = &env.payload["value"];
    let device_profile_id = state.store.latest_device_profile_id().ok().flatten();
    let volume_id = state.store.active_volume_db_id().ok().flatten();
    let input = BenchmarkInput {
        device_profile_id,
        volume_id,
        model_name: model.clone(),
        model_digest,
        quantization,
        context_length: ctx,
        ollama_version,
        storage_media_kind: media_kind,
        cold_load_ms: val["cold_load_ms"].as_f64(),
        warm_load_ms: val["warm_load_ms"]["median"].as_f64(),
        ttft_median_ms: val["ttft_ms"]["median"].as_f64(),
        tok_per_sec_median: val["generation_tok_per_sec"]["median"].as_f64(),
        peak_ram_bytes: val["peak_ram_used_bytes"].as_u64(),
        repetitions: reps,
        raw_report_json: serde_json::to_string(val).unwrap_or_else(|_| "{}".into()),
    };

    let saved = benchmark_store::save_benchmark_report(&state.store, &input)
        .map_err(|e| e.to_string())?;
    let _ = telemetry::log_diagnostic(&state.store, "info", "benchmark", &format!("Completed benchmark {} for {model}", saved.id));
    Ok(saved)
}

fn default_batches_opts(
    profile: &str,
    ctx: u32,
    settings: &crate::core::settings_store::AppSettingsSnapshot,
    system: &system_probe::SystemProfile,
) -> serde_json::Value {
    default_benchmark_options(profile, ctx, settings, system)
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
pub async fn analyze_benchmark_performance(
    report_id: String,
    state: State<'_, AppState>,
) -> Result<PerformanceAnalysisReport, String> {
    let report = benchmark_store::get_benchmark_report(&state.store, &report_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Benchmark report not found.".to_string())?;
    let raw_report: serde_json::Value =
        serde_json::from_str(&report.raw_report_json).unwrap_or_else(|_| serde_json::json!({}));
    let system = system_probe::probe_system();
    let params = serde_json::json!({
        "report": raw_report,
        "system_profile": system,
        "storage": { "media_kind": report.storage_media_kind },
        "media_kind": report.storage_media_kind,
        "execution_plan": raw_report.get("applied_options"),
    });
    let (_, env) = python_analytics_service::run_single_job("analyze_performance", params, 8)
        .await
        .map_err(|e| e.to_string())?;
    if env.kind == "error" {
        return Err(env.payload["error"]["message"]
            .as_str()
            .unwrap_or("Performance analysis failed")
            .to_string());
    }
    let mut val = env.payload["value"].clone();
    if let Some(obj) = val.as_object_mut() {
        obj.insert("confidence".into(), env.payload["confidence"].clone());
        obj.insert("limitations".into(), env.payload["limitations"].clone());
    }
    serde_json::from_value::<PerformanceAnalysisReport>(val)
        .map_err(|e| format!("Invalid performance analysis payload: {e}"))
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
    if env.kind == "error" {
        return Err(env.payload["error"]["message"]
            .as_str()
            .unwrap_or("Benchmark export failed")
            .to_string());
    }

    let val = &env.payload["value"];
    Ok(ExportedReport {
        format: val["format"].as_str().unwrap_or(&format).to_string(),
        content: val["content"].as_str().unwrap_or("").to_string(),
    })
}
