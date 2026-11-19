use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub use crate::core::volume_parsers::{
    build_volume_advisory, normalize_media_kind, parse_linux_lsblk_json, parse_macos_storage_json,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::security::command_guard;
use crate::security::{path_guard, SecurityError};

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

pub fn find_live_writable_volume<'a>(
    volumes: &'a [ExternalVolume],
    volume_identifier: &str,
) -> Option<&'a ExternalVolume> {
    volumes
        .iter()
        .find(|v| v.volume_identifier == volume_identifier && v.writable)
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

    let probe_file = path_guard::resolve_within(
        &models_dir,
        Path::new(&format!(".mosaic-probe-{}", Uuid::new_v4())),
    )?;
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

    fn test_vol(id: &str, writable: bool, free_bytes: u64) -> ExternalVolume {
        ExternalVolume {
            volume_identifier: id.into(),
            label: id.into(),
            mount_path: format!("/Volumes/{id}"),
            filesystem: "APFS".into(),
            protocol: "USB".into(),
            media_kind: "SSD".into(),
            total_bytes: 2000,
            free_bytes,
            writable,
            advisory: None,
        }
    }

    #[test]
    fn find_live_writable_volume_requires_writable_match() {
        let vols = vec![test_vol("RO-1", false, 500), test_vol("RW-1", true, 1500)];
        assert!(find_live_writable_volume(&vols, "RO-1").is_none());
        assert_eq!(find_live_writable_volume(&vols, "RW-1").unwrap().free_bytes, 1500);
    }

    #[test]
    fn prepare_safe_eject_refuses_when_operations_are_active() {
        let err = prepare_safe_eject("/Volumes/One Touch", true).unwrap_err();
        assert!(err.to_string().contains("Stop active model downloads or inference before ejecting."));
    }
}
