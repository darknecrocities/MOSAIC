use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::core::catalog_security::{self, MAX_CATALOG_BYTES};
use crate::core::python_analytics_service;
use crate::core::settings_store::SettingsStore;
use crate::core::system_probe::{self, SystemProfile};
use crate::security::command_guard;

const CURATED_CATALOG_JSON: &str = include_str!("catalog_data.json");
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
pub const DEFAULT_CATALOG_REFRESH_URL: &str =
    "https://raw.githubusercontent.com/darknecrocities/mosaic/main/src-tauri/src/core/catalog_data.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModelEntry {
    pub ollama_name: String,
    pub display_name: String,
    pub provider: String,
    pub parameter_billions: f64,
    #[serde(default)]
    pub active_parameter_billions: Option<f64>,
    #[serde(default)]
    pub is_moe: bool,
    pub quantization: String,
    pub download_size_bytes: u64,
    pub n_layers: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
    pub default_context: u32,
    pub license_name: String,
    pub license_url: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ExecutionPlan {
    pub profile: String,
    pub kv_cache_type: String,
    pub num_ctx: u32,
    pub num_gpu: i32,
    pub num_batch: u32,
    pub num_ubatch: u32,
    pub num_thread: u32,
    pub use_mmap: bool,
    pub use_mlock: bool,
    pub keep_alive: String,
    pub flash_attention: bool,
    pub num_parallel: u32,
    pub offload_ratio: f64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFitAssessment {
    pub fit_status: String,
    pub weight_memory_estimate: Option<u64>,
    pub runtime_overhead_estimate: Option<u64>,
    pub kv_cache_estimate: Option<u64>,
    pub total_estimated_bytes: Option<u64>,
    pub available_budget: Option<u64>,
    pub context_length: u32,
    pub expected_backend: String,
    pub performance_estimate: String,
    pub reasons: Vec<String>,
    pub source: String,
    pub confidence: String,
    #[serde(default)]
    pub execution_plan: Option<ExecutionPlan>,
    #[serde(default)]
    pub requested_context_length: Option<u32>,
    #[serde(default)]
    pub gpu_budget_bytes: Option<u64>,
    #[serde(default)]
    pub cpu_spill_budget_bytes: Option<u64>,
    #[serde(default)]
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModelWithFit {
    pub model: CatalogModelEntry,
    pub fit: ModelFitAssessment,
}

pub fn load_curated_catalog() -> Vec<CatalogModelEntry> {
    serde_json::from_str(CURATED_CATALOG_JSON).unwrap_or_default()
}

pub fn validate_catalog_entries(entries: &[CatalogModelEntry]) -> Result<(), String> {
    if entries.is_empty() {
        return Err("Catalog must contain at least one model entry.".into());
    }
    for e in entries {
        command_guard::validate_model_name(&e.ollama_name).map_err(|err| err.to_string())?;
        if e.display_name.trim().is_empty()
            || e.download_size_bytes == 0
            || !e.parameter_billions.is_finite()
            || e.parameter_billions <= 0.0
            || e.n_layers == 0
            || !e.license_url.starts_with("https://")
        {
            return Err(format!("Invalid catalog entry metadata for '{}'.", e.ollama_name));
        }
    }
    Ok(())
}

pub fn load_effective_catalog(store: Option<&SettingsStore>) -> Vec<CatalogModelEntry> {
    if let Some(st) = store {
        if let Ok(Some(raw)) = st.load_catalog_snapshot_json() {
            if let Ok(entries) = serde_json::from_str::<Vec<CatalogModelEntry>>(&raw) {
                if validate_catalog_entries(&entries).is_ok() {
                    return entries;
                }
            }
        }
    }
    load_curated_catalog()
}

/// Optional HTTPS catalog refresh with strict SSRF, redirect, size, and schema checks.
pub async fn refresh_catalog_https(url: &str) -> Result<Vec<CatalogModelEntry>, String> {
    let bytes = catalog_security::fetch_public_https_bounded(url, MAX_CATALOG_BYTES).await?;
    let entries: Vec<CatalogModelEntry> =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid catalog schema: {e}"))?;
    validate_catalog_entries(&entries)?;
    Ok(entries)
}

pub fn fallback_estimate_fit(
    model: &CatalogModelEntry,
    system: &SystemProfile,
    context_length: u32,
    safety_reserve_gib: f64,
    media_kind: Option<&str>,
) -> ModelFitAssessment {
    let weight_bytes = (model.download_size_bytes as f64 * 1.03) as u64;
    let kv_bytes = 2_u64
        * u64::from(model.n_layers)
        * u64::from(model.n_kv_heads)
        * u64::from(model.head_dim)
        * u64::from(context_length)
        * 2;
    let gpu_vram = system_probe::primary_gpu_vram_bytes(system);
    let backend = if system.is_unified_memory {
        "unified_metal"
    } else if gpu_vram.is_some_and(|v| v > 0) {
        "discrete_gpu"
    } else {
        "cpu_ram"
    };
    let overhead_bytes = 384 * 1024 * 1024 + (weight_bytes * 8 / 100);
    let total_required = weight_bytes + kv_bytes + overhead_bytes;

    let raw_budget = if let Some(vram) = gpu_vram.filter(|v| *v > 0 && !system.is_unified_memory) {
        vram
    } else if system.ram_available_bytes > 0 {
        system.ram_available_bytes
    } else {
        (system.ram_total_bytes as f64 * 0.65) as u64
    };
    let reserve_bytes = (safety_reserve_gib * GIB) as u64;
    let available_budget = raw_budget.saturating_sub(reserve_bytes);

    let mut reasons = Vec::new();
    let fit_status = if total_required <= (available_budget * 85 / 100) {
        reasons.push(format!(
            "Estimated {:.1} GiB runtime demand fits within {:.1} GiB safe budget.",
            total_required as f64 / GIB,
            available_budget as f64 / GIB
        ));
        "Recommended".to_string()
    } else if total_required <= (available_budget * 115 / 100) {
        reasons.push(format!(
            "Estimated {:.1} GiB demand is near your {:.1} GiB budget; reduce context if needed.",
            total_required as f64 / GIB,
            available_budget as f64 / GIB
        ));
        "Borderline".to_string()
    } else {
        reasons.push(format!(
            "Estimated {:.1} GiB demand exceeds your {:.1} GiB safe budget.",
            total_required as f64 / GIB,
            available_budget as f64 / GIB
        ));
        "Not recommended".to_string()
    };

    if media_kind.is_some_and(|k| k.eq_ignore_ascii_case("HDD")) {
        reasons.push("External HDD selected: model loading will be slower than SSD.".to_string());
    }

    ModelFitAssessment {
        fit_status,
        weight_memory_estimate: Some(weight_bytes),
        runtime_overhead_estimate: Some(overhead_bytes),
        kv_cache_estimate: Some(kv_bytes),
        total_estimated_bytes: Some(total_required),
        available_budget: Some(available_budget),
        context_length,
        expected_backend: backend.to_string(),
        performance_estimate: "Not benchmarked yet".to_string(),
        reasons,
        source: "estimated".to_string(),
        confidence: "medium".to_string(),
        execution_plan: None,
        requested_context_length: Some(context_length),
        gpu_budget_bytes: gpu_vram,
        cpu_spill_budget_bytes: None,
        limitations: Vec::new(),
    }
}

#[derive(Debug, Deserialize)]
struct BatchFitItem {
    #[serde(default)]
    model_id: Option<String>,
    #[serde(flatten)]
    assessment: ModelFitAssessment,
}

pub fn build_batch_fit_params(
    entries: &[CatalogModelEntry],
    system: &SystemProfile,
    context_length: u32,
    safety_reserve_gib: f64,
    media_kind: Option<&str>,
    execution_profile: Option<&str>,
    kv_cache_type: Option<&str>,
) -> serde_json::Value {
    let mut sys_val = serde_json::to_value(system).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = sys_val.as_object_mut() {
        obj.insert("gpu_vram_bytes".into(), serde_json::json!(system_probe::primary_gpu_vram_bytes(system)));
    }
    let mk = media_kind.unwrap_or("unknown");
    serde_json::json!({
        "system_profile": sys_val,
        "models": entries,
        "storage": { "media_kind": mk },
        "media_kind": mk,
        "context_length": context_length,
        "safety_reserve_gib": safety_reserve_gib,
        "execution_profile": execution_profile.unwrap_or("auto_adaptive"),
        "kv_cache_type": kv_cache_type,
    })
}

pub fn merge_batch_assessments(
    entries: Vec<CatalogModelEntry>,
    raw_assessments: Option<&Vec<serde_json::Value>>,
    system: &SystemProfile,
    context_length: u32,
    safety_reserve_gib: f64,
    media_kind: Option<&str>,
) -> Vec<CatalogModelWithFit> {
    let mut by_id: HashMap<String, ModelFitAssessment> = HashMap::new();
    let mut by_idx: Vec<Option<ModelFitAssessment>> = Vec::new();
    if let Some(items) = raw_assessments {
        for item in items {
            if let Ok(parsed) = serde_json::from_value::<BatchFitItem>(item.clone()) {
                if let Some(mid) = parsed.model_id {
                    by_id.insert(mid, parsed.assessment.clone());
                }
                by_idx.push(Some(parsed.assessment));
            } else {
                by_idx.push(None);
            }
        }
    }

    entries
        .into_iter()
        .enumerate()
        .map(|(idx, entry)| {
            let fit = by_id
                .remove(&entry.ollama_name)
                .or_else(|| by_idx.get_mut(idx).and_then(Option::take))
                .unwrap_or_else(|| {
                    fallback_estimate_fit(&entry, system, context_length, safety_reserve_gib, media_kind)
                });
            CatalogModelWithFit { model: entry, fit }
        })
        .collect()
}

pub async fn evaluate_catalog(
    entries: Vec<CatalogModelEntry>,
    system: &SystemProfile,
    context_length: u32,
    safety_reserve_gib: f64,
    media_kind: Option<&str>,
    execution_profile: Option<&str>,
    kv_cache_type: Option<&str>,
) -> Vec<CatalogModelWithFit> {
    let params = build_batch_fit_params(
        &entries, system, context_length, safety_reserve_gib,
        media_kind, execution_profile, kv_cache_type,
    );
    let raw = match python_analytics_service::run_single_job("estimate_fit_batch", params, 10).await {
        Ok((_, env)) if env.kind == "result" => {
            env.payload["value"]["assessments"].as_array().cloned()
        }
        _ => None,
    };
    merge_batch_assessments(
        entries, raw.as_ref(), system, context_length, safety_reserve_gib, media_kind,
    )
}
