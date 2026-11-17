use serde::{Deserialize, Serialize};

use crate::core::python_analytics_service;
use crate::core::system_probe::SystemProfile;

const CURATED_CATALOG_JSON: &str = include_str!("catalog_data.json");
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModelWithFit {
    pub model: CatalogModelEntry,
    pub fit: ModelFitAssessment,
}

pub fn load_curated_catalog() -> Vec<CatalogModelEntry> {
    serde_json::from_str(CURATED_CATALOG_JSON).unwrap_or_default()
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
    let backend = if system.is_unified_memory {
        "unified_metal"
    } else {
        "cpu_ram"
    };
    let overhead_bytes = 384 * 1024 * 1024 + (weight_bytes * 8 / 100);
    let total_required = weight_bytes + kv_bytes + overhead_bytes;

    let raw_budget = if system.ram_available_bytes > 0 {
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
    }
}

pub async fn evaluate_catalog(
    system: &SystemProfile,
    context_length: u32,
    safety_reserve_gib: f64,
    media_kind: Option<&str>,
) -> Vec<CatalogModelWithFit> {
    let entries = load_curated_catalog();
    let mut results = Vec::with_capacity(entries.len());

    for entry in entries {
        let params = serde_json::json!({
            "model": entry,
            "hardware": {
                "is_unified_memory": system.is_unified_memory,
                "ram_total_bytes": system.ram_total_bytes,
                "ram_available_bytes": system.ram_available_bytes,
                "gpu_vram_bytes": serde_json::Value::Null,
            },
            "storage": { "media_kind": media_kind.unwrap_or("unknown") },
            "context_length": context_length,
            "safety_reserve_gib": safety_reserve_gib,
        });

        let fit = match python_analytics_service::run_single_job("estimate_fit", params, 4).await {
            Ok((_, env)) if env.kind == "result" => {
                let val = &env.payload["value"];
                serde_json::from_value::<ModelFitAssessment>(serde_json::json!({
                    "fit_status": val["fit_status"],
                    "weight_memory_estimate": val["weight_memory_estimate"],
                    "runtime_overhead_estimate": val["runtime_overhead_estimate"],
                    "kv_cache_estimate": val["kv_cache_estimate"],
                    "total_estimated_bytes": val["total_estimated_bytes"],
                    "available_budget": val["available_budget"],
                    "context_length": val["context_length"],
                    "expected_backend": val["expected_backend"],
                    "performance_estimate": val["performance_estimate"],
                    "reasons": val["reasons"],
                    "source": env.payload["source"],
                    "confidence": env.payload["confidence"],
                }))
                .unwrap_or_else(|_| {
                    fallback_estimate_fit(&entry, system, context_length, safety_reserve_gib, media_kind)
                })
            }
            _ => fallback_estimate_fit(
                &entry,
                system,
                context_length,
                safety_reserve_gib,
                media_kind,
            ),
        };

        results.push(CatalogModelWithFit { model: entry, fit });
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_catalog_loads_and_classifies_70b_not_recommended_on_16gb() {
        let catalog = load_curated_catalog();
        assert!(catalog.len() >= 8);
        let seventy = catalog
            .iter()
            .find(|m| m.ollama_name.contains("70b"))
            .unwrap();
        let sys = SystemProfile {
            os_name: "Darwin".into(),
            os_version: "macOS".into(),
            architecture: "aarch64".into(),
            cpu_brand: "Apple M3".into(),
            physical_cores: Some(8),
            logical_cores: 8,
            ram_total_bytes: 16 * 1024_u64.pow(3),
            ram_available_bytes: 9 * 1024_u64.pow(3),
            is_unified_memory: true,
            gpus: vec![],
            gpu_status: "unified_memory".into(),
            detected_at: "2026-11-17T00:00:00Z".into(),
        };
        let fit = fallback_estimate_fit(seventy, &sys, 4096, 2.0, Some("SSD"));
        assert_eq!(fit.fit_status, "Not recommended");
    }
}
