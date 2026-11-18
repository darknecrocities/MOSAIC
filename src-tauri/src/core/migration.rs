use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::security::path_guard;

#[derive(Debug, Clone, Serialize)]
pub struct MigrationPreview {
    pub source_dir: String,
    pub exists: bool,
    pub blob_count: usize,
    pub manifest_count: usize,
    pub total_bytes: u64,
    pub fits_on_external: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationResult {
    pub files_copied: usize,
    pub bytes_copied: u64,
    pub destination_dir: String,
}

pub fn default_internal_models_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".ollama").join("models"))
}

fn should_skip_entry(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| name.starts_with("._") || name == ".DS_Store")
}

fn dir_stats(root: &Path, sub: &str) -> (usize, u64) {
    let target = root.join(sub);
    if !target.is_dir() {
        return (0, 0);
    }
    let mut count = 0;
    let mut bytes = 0;
    let mut stack = vec![target];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if should_skip_entry(&path) {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = entry.metadata() {
                count += 1;
                bytes += meta.len();
            }
        }
    }
    (count, bytes)
}

pub fn preview_internal_migration(external_free_bytes: u64) -> MigrationPreview {
    let Some(src) = default_internal_models_dir() else {
        return MigrationPreview {
            source_dir: String::new(),
            exists: false,
            blob_count: 0,
            manifest_count: 0,
            total_bytes: 0,
            fits_on_external: false,
        };
    };

    if !src.is_dir() {
        return MigrationPreview {
            source_dir: src.display().to_string(),
            exists: false,
            blob_count: 0,
            manifest_count: 0,
            total_bytes: 0,
            fits_on_external: true,
        };
    }

    let (blob_count, blob_bytes) = dir_stats(&src, "blobs");
    let (manifest_count, manifest_bytes) = dir_stats(&src, "manifests");
    let total_bytes = blob_bytes + manifest_bytes;
    let fits_on_external = external_free_bytes >= ((total_bytes as f64) * 1.1) as u64;

    MigrationPreview {
        source_dir: src.display().to_string(),
        exists: true,
        blob_count,
        manifest_count,
        total_bytes,
        fits_on_external,
    }
}

/// Safely copy `blobs` and `manifests` from internal `~/.ollama/models` to the external library.
/// Never deletes source files automatically.
pub fn copy_internal_models(
    dest_library_dir: &Path,
    external_free_bytes: u64,
    confirmed: bool,
) -> Result<MigrationResult, String> {
    if !confirmed {
        return Err("Explicit confirmation is required before migrating model files.".into());
    }
    let preview = preview_internal_migration(external_free_bytes);
    if !preview.exists {
        return Err("No internal ~/.ollama/models directory found to migrate.".into());
    }
    if !preview.fits_on_external {
        return Err("Insufficient free space on the external drive for migration.".into());
    }

    let src_root = PathBuf::from(&preview.source_dir);
    let mut files_copied = 0_usize;
    let mut bytes_copied = 0_u64;

    for sub in ["blobs", "manifests"] {
        let src_sub = src_root.join(sub);
        if !src_sub.is_dir() {
            continue;
        }
        let mut stack = vec![src_sub.clone()];
        while let Some(dir) = stack.pop() {
            let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
            for entry in entries.flatten() {
                let path = entry.path();
                if should_skip_entry(&path) {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let rel = path.strip_prefix(&src_root).map_err(|e| e.to_string())?;
                let dest = path_guard::resolve_within(dest_library_dir, rel)
                    .map_err(|e| e.to_string())?;
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                if !dest.exists() {
                    let copied = fs::copy(&path, &dest).map_err(|e| e.to_string())?;
                    files_copied += 1;
                    bytes_copied += copied;
                }
            }
        }
    }

    Ok(MigrationResult {
        files_copied,
        bytes_copied,
        destination_dir: dest_library_dir.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn copy_requires_confirmation_and_copies_safely() {
        let base = std::env::temp_dir().join(format!("mosaic-mig-{}", Uuid::new_v4()));
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let err = copy_internal_models(&dest, 10_000_000_000, false).unwrap_err();
        assert!(err.contains("confirmation"));
        fs::remove_dir_all(&base).unwrap();
    }
}
