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

#[cfg(target_os = "linux")]
pub fn list_external_volumes() -> Result<Vec<ExternalVolume>, VolumeError> {
    let output = command_guard::run_allowlisted(
        Path::new("lsblk"),
        &[
            "-J",
            "-b",
            "-o",
            "NAME,LABEL,UUID,FSTYPE,MOUNTPOINT,SIZE,FSAVAIL,TRAN,ROTA,RM,RO",
        ],
    )?;
    if !output.status.success() {
        return Err(VolumeError::ProbeFailed(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| VolumeError::ProbeFailed(e.to_string()))?;
    Ok(parse_linux_lsblk_json(&parsed))
}

#[cfg(target_os = "windows")]
pub fn list_external_volumes() -> Result<Vec<ExternalVolume>, VolumeError> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut volumes = Vec::new();
    for disk in disks.list() {
        if !disk.is_removable() || disk.total_space() == 0 {
            continue;
        }
        let mount_path = disk.mount_point().display().to_string();
        let filesystem = disk.file_system().to_string_lossy().to_string();
        let writable = !disk.is_read_only();
        let media_kind = match disk.kind() {
            sysinfo::DiskKind::SSD => "SSD",
            sysinfo::DiskKind::HDD => "HDD",
            _ => "unknown",
        }
        .to_string();
        let label = disk.name().to_string_lossy().to_string();
        let advisory = build_volume_advisory(&filesystem, &media_kind, writable);
        volumes.push(ExternalVolume {
            volume_identifier: mount_path.clone(),
            label: if label.is_empty() {
                mount_path.clone()
            } else {
                label
            },
            mount_path,
            filesystem,
            protocol: "USB/Removable".to_string(),
            media_kind,
            total_bytes: disk.total_space(),
            free_bytes: disk.available_space(),
            writable,
            advisory,
        });
    }
    Ok(volumes)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn list_external_volumes() -> Result<Vec<ExternalVolume>, VolumeError> {
    Ok(Vec::new())
}

pub fn parse_linux_lsblk_json(parsed: &serde_json::Value) -> Vec<ExternalVolume> {
    let mut volumes = Vec::new();
    if let Some(devices) = parsed.get("blockdevices").and_then(|v| v.as_array()) {
        collect_linux_devices(devices, false, "unknown", false, &mut volumes);
    }
    volumes
}

fn collect_linux_devices(
    devices: &[serde_json::Value],
    parent_removable: bool,
    parent_tran: &str,
    parent_rota: bool,
    out: &mut Vec<ExternalVolume>,
) {
    for dev in devices {
        let tran = dev.get("tran").and_then(|v| v.as_str()).unwrap_or(parent_tran);
        let rm = dev.get("rm").and_then(|v| v.as_bool()).unwrap_or(false)
            || parent_removable
            || tran.eq_ignore_ascii_case("usb")
            || tran.eq_ignore_ascii_case("thunderbolt");
        let rota = dev.get("rota").and_then(|v| v.as_bool()).unwrap_or(parent_rota);

        if let Some(mount) = dev.get("mountpoint").and_then(|v| v.as_str()) {
            let fstype = dev.get("fstype").and_then(|v| v.as_str()).unwrap_or("unknown");
            let ro = dev.get("ro").and_then(|v| v.as_bool()).unwrap_or(false);
            if rm && !mount.is_empty() && mount != "/" && !mount.starts_with("/boot") && fstype != "squashfs" {
                let media_kind = if rota { "HDD" } else { "SSD" }.to_string();
                let writable = !ro;
                let advisory = build_volume_advisory(fstype, &media_kind, writable);
                let label = dev
                    .get("label")
                    .and_then(|v| v.as_str())
                    .or_else(|| dev.get("name").and_then(|v| v.as_str()))
                    .unwrap_or("External")
                    .to_string();
                let uuid = dev
                    .get("uuid")
                    .and_then(|v| v.as_str())
                    .unwrap_or(mount)
                    .to_string();
                out.push(ExternalVolume {
                    volume_identifier: uuid,
                    label,
                    mount_path: mount.to_string(),
                    filesystem: fstype.to_string(),
                    protocol: tran.to_string(),
                    media_kind,
                    total_bytes: dev.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    free_bytes: dev.get("fsavail").and_then(|v| v.as_u64()).unwrap_or(0),
                    writable,
                    advisory,
                });
            }
        }
        if let Some(children) = dev.get("children").and_then(|v| v.as_array()) {
            collect_linux_devices(children, rm, tran, rota, out);
        }
    }
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

/// Safely eject an external volume after verifying no active model operations are running.
pub fn prepare_safe_eject(mount_path: &str, active_ops: bool) -> Result<String, VolumeError> {
    if active_ops {
        return Err(VolumeError::ProbeFailed(
            "Stop active model downloads or inference before ejecting.".to_string(),
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let out = command_guard::run_allowlisted(
            Path::new("/usr/sbin/diskutil"),
            &["eject", mount_path],
        )?;
        if !out.status.success() {
            return Err(VolumeError::ProbeFailed(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(format!("Volume at {mount_path} is safe to remove."))
    }

    #[cfg(target_os = "linux")]
    {
        let out = command_guard::run_allowlisted(
            Path::new("udisksctl"),
            &["unmount", "-b", mount_path],
        )?;
        if !out.status.success() {
            return Err(VolumeError::ProbeFailed(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(format!("Volume at {mount_path} unmounted safely."))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = mount_path;
        Ok("Active operations stopped; use OS Safely Remove Hardware to eject.".to_string())
    }
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

    #[test]
    fn parses_linux_lsblk_usb_and_skips_root() {
        let fixture = serde_json::json!({
            "blockdevices": [
                {
                    "name": "nvme0n1",
                    "tran": "nvme",
                    "rm": false,
                    "rota": false,
                    "children": [
                        { "name": "nvme0n1p1", "mountpoint": "/", "fstype": "ext4", "ro": false, "size": 500_000_000_000u64, "fsavail": 200_000_000_000u64 }
                    ]
                },
                {
                    "name": "sda",
                    "tran": "usb",
                    "rm": true,
                    "rota": true,
                    "children": [
                        { "name": "sda1", "label": "OneTouch", "uuid": "LIN-UUID-1", "mountpoint": "/media/user/OneTouch", "fstype": "exfat", "ro": false, "size": 1_000_000_000_000u64, "fsavail": 600_000_000_000u64 }
                    ]
                }
            ]
        });

        let found = parse_linux_lsblk_json(&fixture);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].volume_identifier, "LIN-UUID-1");
        assert_eq!(found[0].media_kind, "HDD");
    }
}
