use crate::core::{ollama_supervisor, settings_store::AppSettingsSnapshot, system_probe};

pub fn default_benchmark_options(
    profile: &str,
    ctx: u32,
    settings: &AppSettingsSnapshot,
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

pub fn compute_job_timeout_s(
    cold_load_timeout_s: Option<f64>,
    model_size_bytes: Option<u64>,
    media_kind: &str,
    reps: u32,
) -> (f64, u64) {
    let cold_s = if let Some(explicit) = cold_load_timeout_s.filter(|v| v.is_finite() && *v > 0.0) {
        explicit.max(30.0)
    } else if let Some(sz) = model_size_bytes.filter(|v| *v > 0) {
        let rate_bps = if media_kind.eq_ignore_ascii_case("SSD")
            || media_kind.eq_ignore_ascii_case("NVME")
        {
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

pub fn resolve_effective_kv(
    profile: &str,
    requested_kv: Option<&str>,
    settings: &AppSettingsSnapshot,
    system: &system_probe::SystemProfile,
) -> String {
    let mut eff = settings.clone();
    eff.execution_profile = profile.trim().to_ascii_lowercase();
    if let Some(kv) = requested_kv.map(str::trim).filter(|s| !s.is_empty()) {
        eff.kv_cache_type = kv.to_ascii_lowercase();
    }
    ollama_supervisor::resolve_adaptive_kv_and_keep_alive(&eff, system)
        .0
        .to_string()
}

pub fn build_analyze_performance_params(
    raw_report: &serde_json::Value,
    media_kind: &str,
    system: &system_probe::SystemProfile,
    settings: &AppSettingsSnapshot,
) -> serde_json::Value {
    let mut plan = raw_report
        .get("applied_options")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let plan_profile = plan
        .get("execution_profile")
        .or_else(|| plan.get("profile"))
        .and_then(|v| v.as_str())
        .unwrap_or(&settings.execution_profile)
        .to_string();
    let raw_kv = plan
        .get("kv_cache_type")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("auto"));
    let resolved_kv = match raw_kv {
        Some(kv) => kv.to_ascii_lowercase(),
        None => resolve_effective_kv(&plan_profile, None, settings, system),
    };
    plan.insert("kv_cache_type".into(), serde_json::json!(resolved_kv));
    serde_json::json!({
        "report": raw_report,
        "system_profile": system,
        "storage": { "media_kind": media_kind },
        "media_kind": media_kind,
        "kv_cache_type": resolved_kv,
        "execution_plan": serde_json::Value::Object(plan),
    })
}

pub fn model_names_match(installed_name: &str, requested_name: &str) -> bool {
    fn norm(s: &str) -> &str {
        s.strip_suffix(":latest").unwrap_or(s)
    }
    installed_name == requested_name || norm(installed_name) == norm(requested_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_16gb_sys() -> system_probe::SystemProfile {
        system_probe::SystemProfile {
            os_name: "Darwin".into(),
            os_version: "15.0".into(),
            architecture: "aarch64".into(),
            cpu_brand: "Apple M3".into(),
            physical_cores: Some(8),
            logical_cores: 8,
            ram_total_bytes: 16 * 1024_u64.pow(3),
            ram_available_bytes: 12 * 1024_u64.pow(3),
            is_unified_memory: true,
            metal_wired_limit_bytes: Some(11 * 1024_u64.pow(3)),
            gpus: vec![],
            gpu_status: "unified_memory".into(),
            detected_at: "2026-11-18T00:00:00Z".into(),
        }
    }

    #[test]
    fn model_names_match_normalizes_latest_tag() {
        assert!(model_names_match("llama3.2:latest", "llama3.2"));
        assert!(model_names_match("llama3.2", "llama3.2:latest"));
        assert!(model_names_match(
            "hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS",
            "hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS"
        ));
        assert!(!model_names_match("llama3.2:3b", "llama3.2:1b"));
    }

    #[test]
    fn analyze_params_preserve_kv_cache_type_and_fallback_from_settings() {
        let sys = sample_16gb_sys();
        let settings = AppSettingsSnapshot {
            execution_profile: "constrained_memory".into(),
            kv_cache_type: "auto".into(),
            ..AppSettingsSnapshot::default()
        };
        let raw_with_kv = serde_json::json!({
            "applied_options": {
                "kv_cache_type": "q4_0",
                "offload_ratio": 0.896,
                "num_ctx": 4096
            }
        });
        let p1 = build_analyze_performance_params(&raw_with_kv, "HDD", &sys, &settings);
        assert_eq!(p1["execution_plan"]["kv_cache_type"], "q4_0");
        assert_eq!(p1["execution_plan"]["offload_ratio"], 0.896);
        assert_eq!(p1["kv_cache_type"], "q4_0");

        let legacy_raw = serde_json::json!({ "applied_options": { "num_ctx": 4096 } });
        let p2 = build_analyze_performance_params(&legacy_raw, "HDD", &sys, &settings);
        assert_eq!(p2["execution_plan"]["kv_cache_type"], "q4_0");
        assert_eq!(p2["kv_cache_type"], "q4_0");
    }
}
