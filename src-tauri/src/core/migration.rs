use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use uuid::Uuid;

use crate::security::path_guard;

static MIGRATION_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_migration_active() -> bool {
    MIGRATION_ACTIVE.load(Ordering::SeqCst)
}

pub struct MigrationActiveGuard;

impl MigrationActiveGuard {
    pub fn try_acquire() -> Result<Self, String> {
        MIGRATION_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "An internal model migration is already in progress.".to_string())
    }
}

impl Drop for MigrationActiveGuard {
    fn drop(&mut self) {
        MIGRATION_ACTIVE.store(false, Ordering::SeqCst);
    }
}

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
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
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
    let _guard = MigrationActiveGuard::try_acquire()?;
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
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if ft.is_symlink() {
                    continue;
                }
                if ft.is_dir() {
                    stack.push(path);
                    continue;
                }
                let rel = path.strip_prefix(&src_root).map_err(|e| e.to_string())?;
                let dest = path_guard::resolve_within(dest_library_dir, rel)
                    .map_err(|e| e.to_string())?;
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let src_len = fs::metadata(&path).map_err(|e| e.to_string())?.len();
                let dest_matches = dest.is_file()
                    && fs::metadata(&dest).ok().map(|m| m.len()) == Some(src_len);
                if !dest_matches {
                    let parent = dest.parent().unwrap_or(dest_library_dir);
                    let tmp_path = parent.join(format!(".mosaic-tmp-{}", Uuid::new_v4()));
                    let copied = match fs::copy(&path, &tmp_path) {
                        Ok(n) => n,
                        Err(e) => {
                            let _ = fs::remove_file(&tmp_path);
                            return Err(e.to_string());
                        }
                    };
                    let tmp_len = fs::metadata(&tmp_path).map(|m| m.len()).unwrap_or(0);
                    if copied != src_len || tmp_len != src_len {
                        let _ = fs::remove_file(&tmp_path);
                        return Err(format!(
                            "Migration byte-count mismatch for {}: expected {src_len}, copied {copied}",
                            rel.display()
                        ));
                    }
                    if dest.exists() {
                        let _ = fs::remove_file(&dest);
                    }
                    if let Err(e) = fs::rename(&tmp_path, &dest) {
                        let _ = fs::remove_file(&tmp_path);
                        return Err(e.to_string());
                    }
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
    use std::sync::Mutex;
    use uuid::Uuid;

    static HOME_LOCK: Mutex<()> = Mutex::new(());

    struct HomeGuard(Option<std::ffi::OsString>);
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            if let Some(prev) = &self.0 {
                std::env::set_var("HOME", prev);
            } else {
                std::env::remove_var("HOME");
            }
        }
    }

    #[test]
    fn copy_requires_confirmation_and_copies_safely() {
        let base = std::env::temp_dir().join(format!("mosaic-mig-{}", Uuid::new_v4()));
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let err = copy_internal_models(&dest, 10_000_000_000, false).unwrap_err();
        assert!(err.contains("confirmation"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn copy_internal_models_succeeds_on_fresh_empty_dest_and_skips_appledouble() {
        let _lock = HOME_LOCK.lock().unwrap();
        let base = std::env::temp_dir().join(format!("mosaic-mig-e2e-{}", Uuid::new_v4()));
        let fake_home = base.join("home");
        let models = fake_home.join(".ollama").join("models");
        let blobs = models.join("blobs");
        let manifests = models.join("manifests").join("registry.ollama.ai").join("library").join("qwen3");
        let dest = base.join("fresh-external");
        fs::create_dir_all(&blobs).unwrap();
        fs::create_dir_all(&manifests).unwrap();
        fs::create_dir_all(&dest).unwrap();

        fs::write(blobs.join("sha256-real"), vec![b'A'; 1024]).unwrap();
        fs::write(blobs.join("._sha256-real"), vec![b'B'; 4096]).unwrap();
        fs::write(blobs.join(".DS_Store"), vec![b'C'; 512]).unwrap();
        fs::write(manifests.join("latest"), vec![b'M'; 256]).unwrap();
        fs::write(models.join("manifests").join("._latest"), vec![b'D'; 4096]).unwrap();

        let _guard = HomeGuard(std::env::var_os("HOME"));
        std::env::set_var("HOME", &fake_home);

        let preview = preview_internal_migration(2000);
        assert!(preview.exists);
        assert_eq!(preview.blob_count, 1);
        assert_eq!(preview.manifest_count, 1);
        assert_eq!(preview.total_bytes, 1280);
        assert!(preview.fits_on_external);

        let res = copy_internal_models(&dest, 2000, true).expect("fresh empty dest migration");
        assert_eq!(res.files_copied, 2);
        assert_eq!(res.bytes_copied, 1280);
        assert!(dest.join("blobs/sha256-real").is_file());
        assert!(dest.join("manifests/registry.ollama.ai/library/qwen3/latest").is_file());
        assert!(!dest.join("blobs/._sha256-real").exists());
        assert!(!dest.join("blobs/.DS_Store").exists());
        assert!(!dest.join("manifests/._latest").exists());

        fs::remove_dir_all(&base).unwrap();
    }
}
