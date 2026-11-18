use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::core::cluster_manager::ClusterError;
use crate::security::path_guard;

static OT_RE: OnceLock<Regex> = OnceLock::new();
static FLOAT_RE: OnceLock<Regex> = OnceLock::new();

pub fn validate_worker_host(host: &str, allow_lan: bool) -> Result<(), ClusterError> {
    let trimmed = host.trim();
    if trimmed.is_empty() || trimmed.len() > 253 {
        return Err(ClusterError::InvalidHost(host.to_string()));
    }
    if trimmed == "169.254.169.254" || trimmed.eq_ignore_ascii_case("metadata.google.internal") {
        return Err(ClusterError::InvalidHost(
            "cloud metadata endpoints are strictly blocked".into(),
        ));
    }
    let is_loopback = trimmed == "127.0.0.1" || trimmed == "localhost" || trimmed == "::1";
    if !is_loopback && !allow_lan {
        return Err(ClusterError::InvalidHost(
            "non-loopback LAN/Tailscale workers require explicit opt-in".into(),
        ));
    }
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        if ip.is_unspecified() || ip.is_multicast() {
            return Err(ClusterError::InvalidHost(host.to_string()));
        }
    } else if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(ClusterError::InvalidHost(host.to_string()));
    }
    Ok(())
}

pub fn is_apple_double_or_hidden(name: &str) -> bool {
    name.starts_with("._") || name == ".DS_Store" || name.starts_with('.')
}

pub fn validate_gguf_path(library_root: &Path, gguf_rel_path: &str) -> Result<PathBuf, String> {
    let trimmed = gguf_rel_path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("GGUF relative path cannot be empty.".into());
    }
    let model_path = path_guard::resolve_within(library_root, Path::new(trimmed))
        .map_err(|e| e.to_string())?;
    let file_name = model_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "GGUF path missing valid filename.".to_string())?;
    if is_apple_double_or_hidden(file_name) {
        return Err(format!("Refusing hidden or AppleDouble resource file: {file_name}"));
    }
    let is_gguf = model_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("gguf"));
    if !is_gguf {
        return Err("Cluster runtime model path must have a .gguf extension.".into());
    }
    if !model_path.is_file() {
        return Err(format!("GGUF file not found on external drive: {}", model_path.display()));
    }
    Ok(model_path)
}

pub fn scan_gguf_files(library_root: &Path) -> Result<Vec<String>, String> {
    if !library_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    let mut stack = vec![library_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if is_apple_double_or_hidden(name) {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("gguf"))
            {
                if let Ok(rel) = path.strip_prefix(library_root) {
                    results.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }
    results.sort();
    Ok(results)
}

fn validate_int_range(flag: &str, val: &str, min: u64, max: u64) -> Result<(), String> {
    let parsed = val
        .parse::<u64>()
        .map_err(|_| format!("Flag '{flag}' requires an integer value, got '{val}'."))?;
    if parsed < min || parsed > max {
        return Err(format!("Flag '{flag}' value {parsed} out of range {min}..={max}."));
    }
    Ok(())
}

fn validate_flag_value(flag: &str, val: &str) -> Result<(), String> {
    if val.is_empty() || val.starts_with('-') || val.contains('\0') || val.contains('\n') || val.contains('\r') {
        return Err(format!("Invalid value for flag '{flag}': '{val}'."));
    }
    match flag {
        "--split-mode" => match val {
            "none" | "layer" | "row" => Ok(()),
            _ => Err(format!("Invalid --split-mode '{val}'.")),
        },
        "--rpc" => {
            let endpoints: Vec<&str> = val.split(',').collect();
            if endpoints.is_empty() || endpoints.len() > 16 {
                return Err("--rpc requires 1..=16 host:port entries.".into());
            }
            for ep in endpoints {
                let (host, port_s) = ep
                    .rsplit_once(':')
                    .ok_or_else(|| format!("Invalid --rpc endpoint '{ep}'."))?;
                let clean_host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
                validate_worker_host(clean_host, true).map_err(|e| e.to_string())?;
                let port: u16 = port_s.parse().map_err(|_| format!("Invalid --rpc port '{port_s}'."))?;
                if port == 0 {
                    return Err("--rpc port must be 1..=65535.".into());
                }
            }
            Ok(())
        }
        "--tensor-split" => {
            let re = FLOAT_RE.get_or_init(|| Regex::new(r"^\d+(\.\d+)?$").expect("float regex"));
            let parts: Vec<&str> = val.split(',').collect();
            if parts.is_empty() || parts.len() > 16 {
                return Err("--tensor-split requires 1..=16 positive numbers.".into());
            }
            for p in parts {
                let parsed: f64 = p.parse().map_err(|_| format!("Invalid --tensor-split '{p}'."))?;
                if !re.is_match(p) || !parsed.is_finite() || parsed <= 0.0 {
                    return Err(format!("Invalid --tensor-split weight '{p}'."));
                }
            }
            Ok(())
        }
        "-ot" => {
            let re = OT_RE.get_or_init(|| {
                Regex::new(r"^[a-zA-Z0-9_.\\*^+\[\]()-]{1,64}=(CPU|Metal|CUDA[0-9]*|Vulkan[0-9]*|ROCm[0-9]*|SYCL[0-9]*|GPU[0-9]*)$")
                    .expect("ot regex")
            });
            if !re.is_match(val) {
                return Err(format!("Invalid -ot tensor override '{val}'."));
            }
            Ok(())
        }
        "-ngl" => validate_int_range(flag, val, 0, 999),
        "-c" => validate_int_range(flag, val, 128, 1_048_576),
        "-t" => validate_int_range(flag, val, 1, 1024),
        "-b" | "-ub" => validate_int_range(flag, val, 1, 65_536),
        "-ctk" | "-ctv" => match val {
            "f32" | "f16" | "bf16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1" => Ok(()),
            _ => Err(format!("Unsupported KV cache type '{val}' for {flag}.")),
        },
        _ => Err(format!("Flag '{flag}' is not allowlisted.")),
    }
}

pub fn validate_llama_extra_flags(extra_flags: &[String]) -> Result<Vec<String>, String> {
    let mut validated = Vec::new();
    let mut i = 0;
    while i < extra_flags.len() {
        let token = extra_flags[i].as_str();
        if token.contains('\0') || token.contains('\n') || token.contains('\r') {
            return Err("Control characters are forbidden in llama-server flags.".into());
        }
        if let Some((flag, inline_val)) = token.split_once('=') {
            if !matches!(flag, "--split-mode" | "--rpc" | "--tensor-split") {
                return Err(format!("Flag '{flag}' is not allowlisted."));
            }
            validate_flag_value(flag, inline_val)?;
            validated.push(flag.to_string());
            validated.push(inline_val.to_string());
            i += 1;
            continue;
        }
        match token {
            "--mmap" | "--no-mlock" => {
                validated.push(token.to_string());
                i += 1;
            }
            "-fa" => {
                validated.push(token.to_string());
                if let Some(next) = extra_flags.get(i + 1) {
                    if !next.starts_with('-') {
                        if !matches!(next.as_str(), "on" | "off" | "auto" | "1" | "0") {
                            return Err(format!("Invalid -fa value '{next}'."));
                        }
                        validated.push(next.clone());
                        i += 2;
                        continue;
                    }
                }
                i += 1;
            }
            "--split-mode" | "--rpc" | "--tensor-split" | "-ot" | "-ngl" | "-c" | "-t" | "-b"
            | "-ub" | "-ctk" | "-ctv" => {
                let val = extra_flags
                    .get(i + 1)
                    .ok_or_else(|| format!("Flag '{token}' requires a value."))?;
                validate_flag_value(token, val)?;
                validated.push(token.to_string());
                validated.push(val.clone());
                i += 2;
            }
            _ => return Err(format!("llama-server flag '{token}' is not allowlisted.")),
        }
    }
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_valid_14_flags_and_blocks_dangerous_flags() {
        let ok = vec![
            "--mmap", "--no-mlock", "-fa", "on", "--split-mode", "layer",
            "--rpc", "192.168.1.20:50052", "--tensor-split", "1,2.5",
            "-ot", "blk.*ffn_.*_exps=CPU", "-ngl", "99", "-c", "8192",
            "-t", "8", "-b", "512", "-ub", "128", "-ctk", "q8_0", "-ctv", "q4_0",
        ]
        .into_iter().map(String::from).collect::<Vec<_>>();
        assert!(validate_llama_extra_flags(&ok).is_ok());
        for bad in [
            vec!["--host", "0.0.0.0"],
            vec!["--port", "9999"],
            vec!["-m", "/etc/passwd"],
            vec!["--rpc", "169.254.169.254:80"],
            vec!["-ngl", "--host"],
            vec!["-ot", "bad/path=CPU"],
        ] {
            let args: Vec<String> = bad.into_iter().map(String::from).collect();
            assert!(validate_llama_extra_flags(&args).is_err(), "expected error for {args:?}");
        }
    }
}
