use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::benchmark_helpers::{
    build_analyze_performance_params, compute_job_timeout_s, default_benchmark_options,
    model_names_match, resolve_effective_kv,
};
use crate::commands::runtime::RuntimeState;
use crate::commands::AppState;
use crate::core::benchmark_store::{self, BenchmarkInput, BenchmarkReportRecord};
use crate::core::{
    model_catalog, model_library, ollama_manager, python_analytics_service, system_probe,
    telemetry, volume_manager,
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
    runtime: State<'_, RuntimeState>,
) -> Result<BenchmarkReportRecord, String> {
    command_guard::validate_model_name(&model).map_err(|e| e.to_string())?;
    let _bench_guard = runtime.begin_benchmark();
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
        .and_then(|list| list.into_iter().find(|m| model_names_match(&m.name, &model)));
    let model_size_bytes = installed.as_ref().map(|m| m.size_bytes);
    let model_digest = installed.as_ref().map(|m| m.digest.clone());
    let quantization = installed.as_ref().and_then(|m| m.quantization_level.clone());
    let ollama_version = ollama_manager::inspect_ollama(Some(&settings.ollama_endpoint))
        .await
        .ok()
        .and_then(|s| s.api_version.or(s.cli_version));

    let effective_opts =
        options.unwrap_or_else(|| default_benchmark_options(&profile, ctx, &settings, &system));
    let effective_kv = resolve_effective_kv(&profile, kv_cache_type.as_deref(), &settings, &system);
    let catalog_match = model_catalog::load_effective_catalog(Some(&state.store))
        .into_iter()
        .find(|e| model_names_match(&e.ollama_name, &model));
    let n_layers = catalog_match.as_ref().map(|e| e.n_layers);
    let mut offload_ratio = effective_opts.get("offload_ratio").and_then(|v| v.as_f64());
    if offload_ratio.is_none() && effective_opts.get("num_gpu").is_none() {
        if let Some(entry) = catalog_match.as_ref() {
            let fit_params = serde_json::json!({
                "model": entry, "system_profile": system,
                "storage": { "media_kind": media_kind }, "context_length": ctx,
                "safety_reserve_gib": settings.safety_reserve_gib,
                "execution_profile": profile, "kv_cache_type": effective_kv,
            });
            if let Ok((_, fit_env)) =
                python_analytics_service::run_single_job("estimate_fit", fit_params, 5).await
            {
                if fit_env.kind == "result" {
                    offload_ratio =
                        fit_env.payload["value"]["execution_plan"]["offload_ratio"].as_f64();
                }
            }
        }
    }
    let (cold_s, job_timeout_s) =
        compute_job_timeout_s(cold_load_timeout_s, model_size_bytes, &media_kind, reps);

    let _ = telemetry::log_diagnostic(
        &state.store,
        "info",
        "benchmark",
        &format!("Started benchmark for {model} (ctx={ctx}, reps={reps}, profile={profile}, kv={effective_kv})"),
    );

    let mut params = serde_json::json!({
        "endpoint": settings.ollama_endpoint,
        "model": model,
        "context_length": ctx,
        "repetitions": reps,
        "cold_load_timeout_s": cold_s,
        "model_size_bytes": model_size_bytes,
        "media_kind": media_kind,
        "execution_profile": profile,
        "kv_cache_type": effective_kv,
        "options": effective_opts,
        "keep_alive": settings.keep_alive,
    });
    if let Some(obj) = params.as_object_mut() {
        if let Some(layers) = n_layers {
            obj.insert("n_layers".into(), serde_json::json!(layers));
        }
        if let Some(ratio) = offload_ratio {
            obj.insert("offload_ratio".into(), serde_json::json!(ratio));
        }
    }

    let (_, env) = python_analytics_service::run_single_job("run_benchmark", params, job_timeout_s)
        .await
        .map_err(|e| {
            let _ = telemetry::log_diagnostic(
                &state.store,
                "error",
                "benchmark",
                &format!("Benchmark error for {model}: {e}"),
            );
            e.to_string()
        })?;
    if env.kind == "error" {
        let msg = env.payload["error"]["message"]
            .as_str()
            .unwrap_or("Benchmark failed")
            .to_string();
        let _ = telemetry::log_diagnostic(
            &state.store,
            "error",
            "benchmark",
            &format!("Benchmark failed for {model}: {msg}"),
        );
        return Err(msg);
    }

    let val = &env.payload["value"];
    let input = BenchmarkInput {
        device_profile_id: state.store.latest_device_profile_id().ok().flatten(),
        volume_id: state.store.active_volume_db_id().ok().flatten(),
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
    let _ = telemetry::log_diagnostic(
        &state.store,
        "info",
        "benchmark",
        &format!("Completed benchmark {} for {model}", saved.id),
    );
    Ok(saved)
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
    let settings = state.store.get_settings().map_err(|e| e.to_string())?;
    let system = system_probe::probe_system();
    let params = build_analyze_performance_params(
        &raw_report,
        &report.storage_media_kind,
        &system,
        &settings,
    );
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
