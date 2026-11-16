use std::path::{Component, Path, PathBuf};

use super::SecurityError;

/// Canonicalize `root` and safely resolve `candidate` strictly inside `root`.
/// Rejects parent traversal (`..`) and verifies prefix matching with a trailing separator.
pub fn resolve_within(root: &Path, candidate: &Path) -> Result<PathBuf, SecurityError> {
    let canonical_root = std::fs::canonicalize(root)?;
    if !canonical_root.is_dir() {
        return Err(SecurityError::InvalidPath);
    }

    for comp in candidate.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(SecurityError::InvalidPath);
        }
    }

    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        canonical_root.join(candidate)
    };

    let resolved = if joined.exists() {
        std::fs::canonicalize(&joined)?
    } else {
        let parent = joined.parent().ok_or(SecurityError::InvalidPath)?;
        let file_name = joined.file_name().ok_or(SecurityError::InvalidPath)?;
        let canonical_parent = std::fs::canonicalize(parent)?;
        canonical_parent.join(file_name)
    };

    if resolved == canonical_root || resolved.starts_with(&canonical_root) {
        Ok(resolved)
    } else {
        Err(SecurityError::PathOutsideBoundary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn allows_child_inside_root() {
        let base = std::env::temp_dir().join(format!("mosaic-pg-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let resolved = resolve_within(&base, Path::new("ollama-models")).unwrap();
        assert!(resolved.starts_with(fs::canonicalize(&base).unwrap()));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_parent_traversal() {
        let base = std::env::temp_dir().join(format!("mosaic-pg-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let err = resolve_within(&base, Path::new("../etc/passwd")).unwrap_err();
        assert!(matches!(err, SecurityError::InvalidPath));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_sibling_prefix_bypass() {
        let parent = std::env::temp_dir().join(format!("mosaic-pg-{}", Uuid::new_v4()));
        let root = parent.join("drive");
        let sibling = parent.join("drive-malicious");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&sibling).unwrap();

        let err = resolve_within(&root, &sibling.join("payload")).unwrap_err();
        assert!(matches!(err, SecurityError::PathOutsideBoundary));
        fs::remove_dir_all(&parent).unwrap();
    }
}
