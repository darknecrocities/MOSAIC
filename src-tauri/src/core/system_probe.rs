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
    #[serde(default)]
    pub metal_wired_limit_bytes: Option<u64>,
    pub gpus: Vec<GpuDeviceInfo>,
    pub gpu_status: String,
    pub detected_at: String,
}

pub fn parse_vm_stat_available_bytes(raw: &str) -> Option<u64> {
    let mut page_size: Option<u64> = None;
    let mut free_pages: u64 = 0;
    let mut inactive_pages: u64 = 0;
    let mut purgeable_pages: u64 = 0;
    let mut matched = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.split("page size of ").nth(1) {
            if let Some(num) = rest.split_whitespace().next().and_then(|s| s.parse::<u64>().ok()) {
                if num > 0 {
                    page_size = Some(num);
                }
            }
        }
        let parse_pages = |prefix: &str| -> Option<u64> {
            trimmed
                .strip_prefix(prefix)?
                .trim()
                .trim_end_matches('.')
                .parse::<u64>()
                .ok()
        };
        if let Some(n) = parse_pages("Pages free:") {
            free_pages = n;
            matched = true;
        } else if let Some(n) = parse_pages("Pages inactive:") {
            inactive_pages = n;
            matched = true;
        } else if let Some(n) = parse_pages("Pages purgeable:") {
            purgeable_pages = n;
            matched = true;
        }
    }

    let psize = page_size.unwrap_or(16384);
    let total_pages = free_pages.saturating_add(inactive_pages).saturating_add(purgeable_pages);
    if matched && total_pages > 0 {
        Some(total_pages.saturating_mul(psize))
    } else {
        None
    }
}

pub fn parse_iogpu_wired_limit_bytes(raw: &str) -> Option<u64> {
    let mb = raw.trim().parse::<u64>().ok()?;
    if mb > 0 {
        Some(mb.saturating_mul(1024 * 1024))
    } else {
        None
    }
}

pub fn resolve_available_ram_bytes(sys: &System, ram_total_bytes: u64) -> u64 {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = command_guard::run_allowlisted(Path::new("/usr/bin/vm_stat"), &[]) {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(avail) = parse_vm_stat_available_bytes(&text) {
                    return avail.min(ram_total_bytes);
                }
            }
        }
    }
    match sys.available_memory() {
        0 => ram_total_bytes.saturating_sub(sys.used_memory()),
        avail => avail,
    }
    .min(ram_total_bytes)
}

#[cfg(target_os = "macos")]
fn probe_metal_wired_limit_bytes(is_unified_memory: bool) -> Option<u64> {
    if !is_unified_memory {
        return None;
    }
    let output = command_guard::run_allowlisted(
        Path::new("/usr/sbin/sysctl"),
        &["-n", "iogpu.wired_limit_mb"],
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_iogpu_wired_limit_bytes(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn probe_metal_wired_limit_bytes(_is_unified_memory: bool) -> Option<u64> {
    None
}

pub fn primary_gpu_vram_bytes(system: &SystemProfile) -> Option<u64> {
    if system.is_unified_memory {
        return None;
    }
    system
        .gpus
        .iter()
        .filter(|g| !g.unified_memory)
        .filter_map(|g| g.vram_bytes)
        .max()
}

pub fn parse_nvidia_smi_csv(raw: &str) -> Vec<GpuDeviceInfo> {
    let mut devices = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.rsplitn(3, ',').collect();
        if parts.len() != 3 {
            continue;
        }
        let total_mib = match parts[1].trim().parse::<f64>() {
            Ok(v) if v.is_finite() && v > 0.0 => v,
            _ => continue,
        };
        let model = parts[2].trim();
        if model.is_empty() {
            continue;
        }
        let vram_bytes = Some((total_mib * 1024.0 * 1024.0).round() as u64);
        devices.push(GpuDeviceInfo {
            vendor: "nvidia".to_string(),
            model: model.to_string(),
            vram_bytes,
            unified_memory: false,
            source: "measured".to_string(),
        });
    }
    devices
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
    let metal_wired_limit_bytes = probe_metal_wired_limit_bytes(is_unified_memory);
    let ram_total_bytes = sys.total_memory();
    let ram_available_bytes = resolve_available_ram_bytes(&sys, ram_total_bytes);

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
        metal_wired_limit_bytes,
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
    let Ok(output) = command_guard::run_allowlisted(
        Path::new("nvidia-smi"),
        &[
            "--query-gpu=name,memory.total,memory.free",
            "--format=csv,noheader,nounits",
        ],
    ) else {
        return (Vec::new(), "unknown".to_string());
    };
    if !output.status.success() {
        return (Vec::new(), "unknown".to_string());
    }
    let devices = parse_nvidia_smi_csv(&String::from_utf8_lossy(&output.stdout));
    if devices.is_empty() {
        (Vec::new(), "unknown".to_string())
    } else {
        (devices, "measured".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_nonzero_ram_and_cpu() {
        let profile = probe_system();
        assert!(profile.ram_total_bytes > 0 && profile.ram_available_bytes > 0);
        assert!(profile.logical_cores > 0 && !profile.architecture.is_empty());
    }

    #[test]
    fn parses_vm_stat_and_iogpu_and_nvidia_smi() {
        let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages purgeable: 50.\n";
        assert_eq!(parse_vm_stat_available_bytes(vm), Some(350 * 16384));
        assert_eq!(parse_vm_stat_available_bytes("no data"), None);
        assert_eq!(parse_iogpu_wired_limit_bytes("0\n"), None);
        assert_eq!(parse_iogpu_wired_limit_bytes("12288\n"), Some(12288 * 1024 * 1024));
        let smi = "NVIDIA RTX 4090, 24564, 21000\nQuadro, RTX, [N/A], 1000\n";
        let gpus = parse_nvidia_smi_csv(smi);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].vram_bytes, Some(24564 * 1024 * 1024));
    }
}
