use std::path::Path;
use std::process::{Command, Output};
use std::sync::OnceLock;

use regex::Regex;

use super::SecurityError;

const ALLOWED_BINARIES: &[&str] = &[
    "ollama",
    "system_profiler",
    "diskutil",
    "launchctl",
    "lsblk",
    "udisksctl",
    "nvidia-smi",
    "python3",
    "python",
    "uv",
];

static MODEL_TAG_RE: OnceLock<Regex> = OnceLock::new();

/// Validate an Ollama model identifier (e.g. `llama3.2:1b`, `hf.co/org/model:q4_k_m`).
pub fn validate_model_name(name: &str) -> Result<(), SecurityError> {
    if name.contains("..") || name.starts_with('-') {
        return Err(SecurityError::InvalidModelName(name.to_string()));
    }
    let re = MODEL_TAG_RE.get_or_init(|| {
        Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}(:[a-zA-Z0-9._-]{1,64})?$")
            .expect("valid model regex")
    });
    if re.is_match(name) {
        Ok(())
    } else {
        Err(SecurityError::InvalidModelName(name.to_string()))
    }
}

/// Validate that `binary` matches an allow-listed executable name (no shells).
pub fn validate_allowed_binary(binary: &Path) -> Result<(), SecurityError> {
    let file_name = binary
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| SecurityError::BinaryNotAllowed(binary.display().to_string()))?;

    let normalized = file_name.strip_suffix(".exe").unwrap_or(file_name);
    if ALLOWED_BINARIES.contains(&normalized) {
        Ok(())
    } else {
        Err(SecurityError::BinaryNotAllowed(file_name.to_string()))
    }
}

/// Execute an allow-listed binary directly with fixed arguments (zero shell interpolation).
pub fn run_allowlisted(binary: &Path, args: &[&str]) -> Result<Output, SecurityError> {
    validate_allowed_binary(binary)?;
    for arg in args {
        if arg.contains('\0') {
            return Err(SecurityError::InvalidArgument("null byte in arg".into()));
        }
    }
    Command::new(binary)
        .args(args)
        .output()
        .map_err(|err| SecurityError::CommandExecution {
            binary: binary.display().to_string(),
            message: err.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_shells_and_unlisted_binaries() {
        assert!(validate_allowed_binary(Path::new("sh")).is_err());
        assert!(validate_allowed_binary(Path::new("/bin/bash")).is_err());
        assert!(validate_allowed_binary(Path::new("cmd.exe")).is_err());
        assert!(validate_allowed_binary(Path::new("ollama")).is_ok());
        assert!(validate_allowed_binary(Path::new("/usr/local/bin/ollama")).is_ok());
    }

    #[test]
    fn validates_model_identifiers() {
        assert!(validate_model_name("llama3.2:1b").is_ok());
        assert!(validate_model_name("qwen2.5:0.5b-instruct-q4_K_M").is_ok());
        assert!(validate_model_name("llama3.2; rm -rf /").is_err());
        assert!(validate_model_name("../secret:latest").is_err());
        assert!(validate_model_name("--flag").is_err());
    }
}
