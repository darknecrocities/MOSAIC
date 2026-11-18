use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::core::ollama_manager;
use crate::core::settings_store::StoreError;

static KEEP_ALIVE_RE: OnceLock<Regex> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettingsSnapshot {
    pub safety_reserve_gib: f64,
    pub ollama_endpoint: String,
    pub telemetry_poll_ms: u64,
    pub ollama_management_mode: String,
    pub default_context_length: u32,
    pub execution_profile: String,
    pub kv_cache_type: String,
    pub max_loaded_models: u32,
    pub num_thread: Option<u32>,
    pub num_batch: Option<u32>,
    pub num_ubatch: Option<u32>,
    pub keep_alive: String,
    pub num_parallel: u32,
}

impl Default for AppSettingsSnapshot {
    fn default() -> Self {
        Self {
            safety_reserve_gib: 2.0,
            ollama_endpoint: "http://127.0.0.1:11434".to_string(),
            telemetry_poll_ms: 2500,
            ollama_management_mode: "managed_or_detected".to_string(),
            default_context_length: 4096,
            execution_profile: "auto_adaptive".to_string(),
            kv_cache_type: "auto".to_string(),
            max_loaded_models: 1,
            num_thread: None,
            num_batch: None,
            num_ubatch: None,
            keep_alive: "5m".to_string(),
            num_parallel: 1,
        }
    }
}

pub fn validate_keep_alive(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed == "0" {
        return Ok("0".to_string());
    }
    let re = KEEP_ALIVE_RE
        .get_or_init(|| Regex::new(r"^[1-9][0-9]{0,4}[smh]$").expect("valid keep_alive regex"));
    if re.is_match(trimmed) {
        Ok(trimmed.to_string())
    } else {
        Err("keep_alive must be '0' or <number><s|m|h> (e.g. '5m', '30s')".to_string())
    }
}

fn parse_optional_u32(
    key: &str,
    value: &serde_json::Value,
    min_val: u64,
    max_val: u64,
) -> Result<serde_json::Value, StoreError> {
    if value.is_null() {
        return Ok(serde_json::Value::Null);
    }
    let n = value
        .as_u64()
        .ok_or_else(|| StoreError::InvalidSetting(format!("{key} must be an integer or null")))?;
    Ok(serde_json::json!(n.clamp(min_val, max_val)))
}

fn parse_enum(
    key: &str,
    value: &serde_json::Value,
    allowed: &[&str],
) -> Result<serde_json::Value, StoreError> {
    let s = value
        .as_str()
        .map(|v| v.trim().to_ascii_lowercase())
        .ok_or_else(|| StoreError::InvalidSetting(format!("{key} must be a string")))?;
    if allowed.contains(&s.as_str()) {
        Ok(serde_json::json!(s))
    } else {
        Err(StoreError::InvalidSetting(format!(
            "{key} must be one of: {}",
            allowed.join(", ")
        )))
    }
}

pub fn validate_setting(
    key: &str,
    value: &serde_json::Value,
) -> Result<serde_json::Value, StoreError> {
    match key {
        "ollama_endpoint" => {
            let s = value
                .as_str()
                .ok_or_else(|| StoreError::InvalidSetting("ollama_endpoint must be a string".into()))?;
            ollama_manager::validate_loopback_endpoint(s)
                .map_err(|e| StoreError::InvalidSetting(e.to_string()))?;
            Ok(serde_json::json!(s.trim()))
        }
        "safety_reserve_gib" => {
            let v = value
                .as_f64()
                .filter(|x| x.is_finite())
                .ok_or_else(|| StoreError::InvalidSetting("safety_reserve_gib must be finite".into()))?;
            Ok(serde_json::json!(v.clamp(0.5, 64.0)))
        }
        "telemetry_poll_ms" => {
            let v = value
                .as_u64()
                .ok_or_else(|| StoreError::InvalidSetting("telemetry_poll_ms must be integer".into()))?;
            Ok(serde_json::json!(v.clamp(500, 30_000)))
        }
        "ollama_management_mode" => {
            parse_enum(key, value, &["managed_or_detected", "managed_only", "external_only"])
        }
        "default_context_length" => {
            let v = value
                .as_u64()
                .ok_or_else(|| StoreError::InvalidSetting("default_context_length must be integer".into()))?;
            Ok(serde_json::json!(v.clamp(512, 131_072)))
        }
        "execution_profile" => {
            parse_enum(key, value, &["auto_adaptive", "max_quality", "balanced", "constrained_memory"])
        }
        "kv_cache_type" => {
            if value.is_null() {
                return Ok(serde_json::json!("auto"));
            }
            parse_enum(key, value, &["auto", "f16", "q8_0", "q4_0"])
        }
        "max_loaded_models" => {
            let v = value
                .as_u64()
                .ok_or_else(|| StoreError::InvalidSetting("max_loaded_models must be integer".into()))?;
            Ok(serde_json::json!(v.clamp(1, 8)))
        }
        "num_thread" => parse_optional_u32(key, value, 1, 1024),
        "num_batch" => parse_optional_u32(key, value, 1, 8192),
        "num_ubatch" => parse_optional_u32(key, value, 1, 8192),
        "keep_alive" => {
            let s = value
                .as_str()
                .ok_or_else(|| StoreError::InvalidSetting("keep_alive must be a string".into()))?;
            let clean = validate_keep_alive(s).map_err(StoreError::InvalidSetting)?;
            Ok(serde_json::json!(clean))
        }
        "num_parallel" => {
            let v = value
                .as_u64()
                .ok_or_else(|| StoreError::InvalidSetting("num_parallel must be integer".into()))?;
            Ok(serde_json::json!(v.clamp(1, 8)))
        }
        _ => Err(StoreError::InvalidSetting(format!(
            "setting key '{key}' is not allowlisted"
        ))),
    }
}

pub fn apply_setting_row(settings: &mut AppSettingsSnapshot, key: &str, val_json: &str) {
    match key {
        "safety_reserve_gib" => {
            if let Ok(v) = serde_json::from_str::<f64>(val_json) {
                if v.is_finite() {
                    settings.safety_reserve_gib = v.clamp(0.5, 64.0);
                }
            }
        }
        "ollama_endpoint" => {
            if let Ok(v) = serde_json::from_str::<String>(val_json) {
                settings.ollama_endpoint = v;
            }
        }
        "telemetry_poll_ms" => {
            if let Ok(v) = serde_json::from_str::<u64>(val_json) {
                settings.telemetry_poll_ms = v.clamp(500, 30_000);
            }
        }
        "ollama_management_mode" => {
            if let Ok(v) = serde_json::from_str::<String>(val_json) {
                settings.ollama_management_mode = v;
            }
        }
        "default_context_length" => {
            if let Ok(v) = serde_json::from_str::<u32>(val_json) {
                settings.default_context_length = v.clamp(512, 131_072);
            }
        }
        "execution_profile" => {
            if let Ok(v) = serde_json::from_str::<String>(val_json) {
                settings.execution_profile = v;
            }
        }
        "kv_cache_type" => {
            if let Ok(v) = serde_json::from_str::<String>(val_json) {
                settings.kv_cache_type = v;
            }
        }
        "max_loaded_models" => {
            if let Ok(v) = serde_json::from_str::<u32>(val_json) {
                settings.max_loaded_models = v.clamp(1, 8);
            }
        }
        "num_thread" => {
            settings.num_thread = serde_json::from_str::<Option<u32>>(val_json)
                .ok()
                .flatten()
                .map(|v| v.clamp(1, 1024));
        }
        "num_batch" => {
            settings.num_batch = serde_json::from_str::<Option<u32>>(val_json)
                .ok()
                .flatten()
                .map(|v| v.clamp(1, 8192));
        }
        "num_ubatch" => {
            settings.num_ubatch = serde_json::from_str::<Option<u32>>(val_json)
                .ok()
                .flatten()
                .map(|v| v.clamp(1, 8192));
        }
        "keep_alive" => {
            if let Ok(v) = serde_json::from_str::<String>(val_json) {
                if let Ok(clean) = validate_keep_alive(&v) {
                    settings.keep_alive = clean;
                }
            }
        }
        "num_parallel" => {
            if let Ok(v) = serde_json::from_str::<u32>(val_json) {
                settings.num_parallel = v.clamp(1, 8);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_and_clamps_all_settings() {
        assert!(validate_setting("arbitrary_key", &serde_json::json!(1)).is_err());
        assert!(validate_setting("ollama_endpoint", &serde_json::json!("http://0.0.0.0:11434")).is_err());
        assert_eq!(
            validate_setting("safety_reserve_gib", &serde_json::json!(100.0)).unwrap(),
            serde_json::json!(64.0)
        );
        assert_eq!(
            validate_setting("kv_cache_type", &serde_json::Value::Null).unwrap(),
            serde_json::json!("auto")
        );
        assert!(validate_setting("keep_alive", &serde_json::json!("bad")).is_err());
        assert_eq!(
            validate_setting("keep_alive", &serde_json::json!("10m")).unwrap(),
            serde_json::json!("10m")
        );
        assert_eq!(
            validate_setting("execution_profile", &serde_json::json!("constrained_memory")).unwrap(),
            serde_json::json!("constrained_memory")
        );
    }
}
