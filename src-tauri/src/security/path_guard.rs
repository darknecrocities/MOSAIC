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

    let mut missing_tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = joined.as_path();
    loop {
        match cur.symlink_metadata() {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let name = cur.file_name().ok_or(SecurityError::InvalidPath)?;
                missing_tail.push(name.to_os_string());
                cur = cur.parent().ok_or(SecurityError::InvalidPath)?;
            }
            Err(e) => return Err(SecurityError::Io(e)),
        }
    }

    let canonical_ancestor = std::fs::canonicalize(cur)?;
    if !missing_tail.is_empty() && !canonical_ancestor.is_dir() {
        return Err(SecurityError::InvalidPath);
    }
    if canonical_ancestor != canonical_root && !canonical_ancestor.starts_with(&canonical_root) {
        return Err(SecurityError::PathOutsideBoundary);
    }

    let mut resolved = canonical_ancestor;
    for part in missing_tail.iter().rev() {
        resolved.push(part);
    }

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
        let nested = resolve_within(&base, Path::new("blobs/nested/sha256-abc")).unwrap();
        assert!(nested.starts_with(fs::canonicalize(&base).unwrap()));
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

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_with_nonexistent_tail() {
        let base = std::env::temp_dir().join(format!("mosaic-pg-sym-{}", Uuid::new_v4()));
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link_out")).unwrap();

        let err = resolve_within(&root, Path::new("link_out/new_dir/secret")).unwrap_err();
        assert!(matches!(err, SecurityError::PathOutsideBoundary));
        fs::remove_dir_all(&base).unwrap();
    }
}
