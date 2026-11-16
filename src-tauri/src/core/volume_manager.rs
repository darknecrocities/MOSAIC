use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::security::{command_guard, path_guard, SecurityError};

#[derive(Debug, Error)]
pub enum VolumeError {
    #[error("security validation failed: {0}")]
    Security(#[from] SecurityError),
    #[error("volume probe command failed: {0}")]
    ProbeFailed(String),
    #[error("selected volume is not writable: {0}")]
    NotWritable(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExternalVolume {
    pub volume_identifier: String,
    pub label: String,
    pub mount_path: String,
    pub filesystem: String,
    pub protocol: String,
    pub media_kind: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub writable: bool,
    pub advisory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryValidationResult {
    pub volume_identifier: String,
    pub library_path: String,
    pub writable: bool,
    pub free_bytes: u64,
    pub probe_write_mb_s: f64,
}

#[cfg(target_os = "macos")]
pub fn list_external_volumes() -> Result<Vec<ExternalVolume>, VolumeError> {
    let output = command_guard::run_allowlisted(
        Path::new("/usr/sbin/system_profiler"),
        &["SPStorageDataType", "-json"],
    )?;
    if !output.status.success() {
        return Err(VolumeError::ProbeFailed(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| VolumeError::ProbeFailed(e.to_string()))?;
    Ok(parse_macos_storage_json(&parsed))
}

#[cfg(not(target_os = "macos"))]
pub fn list_external_volumes() -> Result<Vec<ExternalVolume>, VolumeError> {
    // Non-macOS native volume adapters will be implemented in Milestone B/E.
    Ok(Vec::new())
}

pub fn parse_macos_storage_json(parsed: &serde_json::Value) -> Vec<ExternalVolume> {
    let Some(items) = parsed.get("SPStorageDataType").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut volumes = Vec::new();
    for item in items {
        let Some(phys) = item.get("physical_drive") else {
            continue;
        };
        let is_internal = phys.get("is_internal_disk").and_then(|v| v.as_str()) == Some("yes");
        let protocol = phys.get("protocol").and_then(|v| v.as_str()).unwrap_or("unknown");
        let device_name = phys.get("device_name").and_then(|v| v.as_str()).unwrap_or("");
        if is_internal || protocol == "Disk Image" || device_name == "Disk Image" {
            continue;
        }
        let mount_path = item.get("mount_point").and_then(|v| v.as_str()).unwrap_or("");
        if mount_path.is_empty() || mount_path.starts_with("/System/Volumes") {
            continue;
        }
        let writable = item.get("writable").and_then(|v| v.as_str()) == Some("yes");
        let filesystem = item.get("file_system").and_then(|v| v.as_str()).unwrap_or("unknown");
        let medium = phys.get("medium_type").and_then(|v| v.as_str()).unwrap_or("unknown");
        let media_kind = normalize_media_kind(medium);
        let advisory = build_volume_advisory(filesystem, &media_kind, writable);
        volumes.push(ExternalVolume {
            volume_identifier: item
                .get("volume_uuid")
                .and_then(|v| v.as_str())
                .unwrap_or(mount_path)
                .to_string(),
            label: item.get("_name").and_then(|v| v.as_str()).unwrap_or("External").to_string(),
            mount_path: mount_path.to_string(),
            filesystem: filesystem.to_string(),
            protocol: protocol.to_string(),
            media_kind,
            total_bytes: item.get("size_in_bytes").and_then(|v| v.as_u64()).unwrap_or(0),
            free_bytes: item.get("free_space_in_bytes").and_then(|v| v.as_u64()).unwrap_or(0),
            writable,
            advisory,
        });
    }
    volumes
}

fn normalize_media_kind(raw: &str) -> String {
    match raw.to_ascii_lowercase().as_str() {
        "ssd" | "solid state" => "SSD".to_string(),
        "hdd" | "rotational" => "HDD".to_string(),
        _ => "unknown".to_string(),
    }
}

fn build_volume_advisory(filesystem: &str, media_kind: &str, writable: bool) -> Option<String> {
    if !writable {
        return Some("Volume is mounted read-only and cannot store models.".to_string());
    }
    if media_kind == "HDD" {
        return Some(
            "External HDD detected: supported for storage, but SSD is recommended for faster model loading.".to_string(),
        );
    }
    if filesystem.eq_ignore_ascii_case("exFAT") {
        return Some(
            "exFAT works cross-platform; native APFS/NTFS/ext4 is recommended for reliability.".to_string(),
        );
    }
    None
}

/// Validate write access inside `<mount_path>/MOSAIC/ollama-models` without touching internal disk.
pub fn validate_library_path(volume: &ExternalVolume) -> Result<LibraryValidationResult, VolumeError> {
    if !volume.writable {
        return Err(VolumeError::NotWritable(volume.mount_path.clone()));
    }
    let mount_root = PathBuf::from(&volume.mount_path);
    let mosaic_dir = path_guard::resolve_within(&mount_root, Path::new("MOSAIC"))?;
    fs::create_dir_all(&mosaic_dir)?;
    let models_dir = path_guard::resolve_within(&mosaic_dir, Path::new("ollama-models"))?;
    fs::create_dir_all(&models_dir)?;

    let probe_file =
        path_guard::resolve_within(&models_dir, Path::new(&format!(".mosaic-probe-{}", Uuid::new_v4())))?;
    let payload = vec![b'M'; 256 * 1024];
    let started = std::time::Instant::now();
    fs::write(&probe_file, &payload)?;
    let _ = fs::read(&probe_file)?;
    fs::remove_file(&probe_file)?;
    let elapsed = started.elapsed().as_secs_f64().max(0.000_1);
    let mb_s = (payload.len() as f64 / (1024.0 * 1024.0)) / elapsed;

    Ok(LibraryValidationResult {
        volume_identifier: volume.volume_identifier.clone(),
        library_path: models_dir.display().to_string(),
        writable: true,
        free_bytes: volume.free_bytes,
        probe_write_mb_s: (mb_s * 10.0).round() / 10.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_internal_and_disk_images() {
        let fixture = serde_json::json!({
            "SPStorageDataType": [
                {
                    "_name": "Macintosh HD",
                    "mount_point": "/",
                    "file_system": "APFS",
                    "writable": "yes",
                    "size_in_bytes": 500_000_000_000u64,
                    "free_space_in_bytes": 100_000_000_000u64,
                    "volume_uuid": "INT-1",
                    "physical_drive": { "is_internal_disk": "yes", "protocol": "Apple Fabric", "medium_type": "ssd" }
                },
                {
                    "_name": "Installer DMG",
                    "mount_point": "/Volumes/Installer",
                    "file_system": "APFS",
                    "writable": "no",
                    "size_in_bytes": 100_000_000u64,
                    "free_space_in_bytes": 0u64,
                    "volume_uuid": "DMG-1",
                    "physical_drive": { "is_internal_disk": "no", "protocol": "Disk Image", "device_name": "Disk Image" }
                },
                {
                    "_name": "MOSAIC_SSD",
                    "mount_point": "/Volumes/MOSAIC_SSD",
                    "file_system": "APFS",
                    "writable": "yes",
                    "size_in_bytes": 1_000_000_000_000u64,
                    "free_space_in_bytes": 750_000_000_000u64,
                    "volume_uuid": "EXT-UUID-99",
                    "physical_drive": { "is_internal_disk": "no", "protocol": "USB", "medium_type": "ssd" }
                }
            ]
        });

        let found = parse_macos_storage_json(&fixture);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].volume_identifier, "EXT-UUID-99");
        assert_eq!(found[0].media_kind, "SSD");
    }
}
