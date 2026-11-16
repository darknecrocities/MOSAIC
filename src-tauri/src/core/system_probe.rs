use std::path::Path;

use serde::{Deserialize, Serialize};
use sysinfo::System;

use crate::security::command_guard;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuDeviceInfo {
    pub vendor: String,
    pub model: String,
    pub vram_bytes: Option<u64>,
    pub unified_memory: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemProfile {
    pub os_name: String,
    pub os_version: String,
    pub architecture: String,
    pub cpu_brand: String,
    pub physical_cores: Option<usize>,
    pub logical_cores: usize,
    pub ram_total_bytes: u64,
    pub ram_available_bytes: u64,
    pub is_unified_memory: bool,
    pub gpus: Vec<GpuDeviceInfo>,
    pub gpu_status: String,
    pub detected_at: String,
}

pub fn probe_system() -> SystemProfile {
    let mut sys = System::new_all();
    sys.refresh_memory();
    sys.refresh_cpu_specifics(sysinfo::CpuRefreshKind::everything());

    let os_name = System::name().unwrap_or_else(|| std::env::consts::OS.to_string());
    let os_version = System::long_os_version().unwrap_or_else(|| "unknown".to_string());
    let architecture = std::env::consts::ARCH.to_string();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    let is_unified_memory =
        std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64";
    let (gpus, gpu_status) = detect_gpus(is_unified_memory);
    let ram_total_bytes = sys.total_memory();
    let ram_available_bytes = match sys.available_memory() {
        0 => ram_total_bytes.saturating_sub(sys.used_memory()),
        avail => avail,
    };

    SystemProfile {
        os_name,
        os_version,
        architecture,
        cpu_brand,
        physical_cores: sys.physical_core_count(),
        logical_cores: sys.cpus().len(),
        ram_total_bytes,
        ram_available_bytes,
        is_unified_memory,
        gpus,
        gpu_status,
        detected_at: chrono::Utc::now().to_rfc3339(),
    }
}

#[cfg(target_os = "macos")]
fn detect_gpus(is_unified_memory: bool) -> (Vec<GpuDeviceInfo>, String) {
    let Ok(output) = command_guard::run_allowlisted(
        Path::new("/usr/sbin/system_profiler"),
        &["SPDisplaysDataType", "-json"],
    ) else {
        return (Vec::new(), "unknown".to_string());
    };

    if !output.status.success() {
        return (Vec::new(), "unknown".to_string());
    }

    let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return (Vec::new(), "unknown".to_string());
    };

    let mut devices = Vec::new();
    if let Some(items) = parsed.get("SPDisplaysDataType").and_then(|v| v.as_array()) {
        for item in items {
            let model = item
                .get("sppci_model")
                .or_else(|| item.get("_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let vendor = item
                .get("spdisplays_vendor")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .replace("sppci_vendor_", "");
            devices.push(GpuDeviceInfo {
                vendor,
                model,
                vram_bytes: None,
                unified_memory: is_unified_memory,
                source: if is_unified_memory {
                    "unified_memory".to_string()
                } else {
                    "measured".to_string()
                },
            });
        }
    }

    let status = if devices.is_empty() {
        "unknown".to_string()
    } else if is_unified_memory {
        "unified_memory".to_string()
    } else {
        "measured".to_string()
    };
    (devices, status)
}

#[cfg(not(target_os = "macos"))]
fn detect_gpus(_is_unified_memory: bool) -> (Vec<GpuDeviceInfo>, String) {
    let _ = command_guard::validate_allowed_binary(Path::new("nvidia-smi"));
    (Vec::new(), "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_nonzero_ram_and_cpu() {
        let profile = probe_system();
        assert!(profile.ram_total_bytes > 0);
        assert!(profile.ram_available_bytes > 0);
        assert!(profile.logical_cores > 0);
        assert!(!profile.architecture.is_empty());
    }
}
