use std::fs;
use std::path::Path;

use mosaic_lib::core::cluster_flags::{scan_gguf_files, validate_gguf_path};
use mosaic_lib::core::model_catalog;
use mosaic_lib::core::python_analytics_service::{
    candidate_python_project_dirs, run_single_job_in_dir, AnalyticsError,
};
use mosaic_lib::core::settings_store::SettingsStore;
use mosaic_lib::core::system_probe::{GpuDeviceInfo, SystemProfile};
use uuid::Uuid;

fn discrete_sys() -> SystemProfile {
    SystemProfile {
        os_name: "Linux".into(),
        os_version: "6.8".into(),
        architecture: "x86_64".into(),
        cpu_brand: "Ryzen 9".into(),
        physical_cores: Some(8),
        logical_cores: 16,
        ram_total_bytes: 32 * 1024_u64.pow(3),
        ram_available_bytes: 24 * 1024_u64.pow(3),
        is_unified_memory: false,
        metal_wired_limit_bytes: None,
        gpus: vec![GpuDeviceInfo {
            vendor: "nvidia".into(),
            model: "RTX 4090".into(),
            vram_bytes: Some(24 * 1024_u64.pow(3)),
            unified_memory: false,
            source: "measured".into(),
        }],
        gpu_status: "measured".into(),
        detected_at: "2026-11-18T00:00:00Z".into(),
    }
}

#[tokio::test]
async fn catalog_batch_params_and_https_refresh_hardening() {
    let entries = model_catalog::load_curated_catalog();
    assert!(entries.len() >= 17);
    let sys = discrete_sys();
    let params = model_catalog::build_batch_fit_params(
        &entries,
        &sys,
        8192,
        2.0,
        Some("SSD"),
        Some("balanced"),
        Some("q8_0"),
    );
    assert_eq!(params["system_profile"]["gpu_vram_bytes"], 24 * 1024_u64.pow(3));
    assert_eq!(params["execution_profile"], "balanced");
    assert_eq!(params["kv_cache_type"], "q8_0");

    let results = model_catalog::evaluate_catalog(
        entries.clone(),
        &sys,
        4096,
        2.0,
        Some("SSD"),
        Some("auto_adaptive"),
        None,
    )
    .await;
    assert_eq!(results.len(), entries.len());

    assert!(model_catalog::refresh_catalog_https("http://example.com/cat.json").await.is_err());
    assert!(model_catalog::refresh_catalog_https("https://user:pass@example.com/cat.json").await.is_err());

    let store = SettingsStore::open_in_memory().unwrap();
    assert!(store.set_setting("catalog_snapshot_json", &serde_json::json!("[]")).is_err());
    let snap = serde_json::to_string(&entries[..2]).unwrap();
    store.save_catalog_snapshot_json(&snap).unwrap();
    assert_eq!(model_catalog::load_effective_catalog(Some(&store)).len(), 2);
}

#[test]
fn gguf_validation_skips_appledouble_and_non_gguf() {
    let root = std::env::temp_dir().join(format!("mosaic-gguf-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("model.gguf"), b"GGUF").unwrap();
    fs::write(root.join("._model.gguf"), b"appledouble").unwrap();
    fs::write(root.join(".DS_Store"), b"ds").unwrap();
    fs::write(root.join("weights.bin"), b"bin").unwrap();

    assert!(validate_gguf_path(&root, "model.gguf").is_ok());
    assert!(validate_gguf_path(&root, "._model.gguf").is_err());
    assert!(validate_gguf_path(&root, "weights.bin").is_err());
    assert_eq!(scan_gguf_files(&root).unwrap(), vec!["model.gguf".to_string()]);

    fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn python_service_captures_large_stderr_without_deadlock_and_checks_paths() {
    let dirs = candidate_python_project_dirs(
        Some(Path::new("/app/Res")),
        Some(Path::new("/app/Contents/MacOS")),
        Some(Path::new("/work")),
    );
    assert!(dirs.contains(&Path::new("/app/Res/python-analytics").to_path_buf()));
    assert!(dirs.contains(&Path::new("/app/Contents/MacOS/../Resources/resources/python-analytics").to_path_buf()));
    assert!(dirs.contains(&Path::new("/app/Contents/MacOS/python-analytics").to_path_buf()));

    let root = std::env::temp_dir().join(format!("mosaic-pyerr-{}", Uuid::new_v4()));
    let pkg = root.join("src").join("mosaic_analytics");
    fs::create_dir_all(&pkg).unwrap();
    fs::write(root.join("pyproject.toml"), "[project]\nname='test'\n").unwrap();
    fs::write(
        pkg.join("__main__.py"),
        "import sys\nsys.stderr.write('E' * 80000 + '\\nBOOM_STDERR_MARKER')\nsys.stderr.flush()\nsys.exit(1)\n",
    )
    .unwrap();

    let py = Path::new("/usr/bin/python3");
    let target_py = if py.is_file() {
        py
    } else {
        Path::new("python3")
    };
    let err = run_single_job_in_dir(&root, target_py, "ping", serde_json::json!({}), 5)
        .await
        .unwrap_err();
    match err {
        AnalyticsError::Protocol(msg) => assert!(msg.contains("stderr:")),
        other => panic!("unexpected error variant: {other:?}"),
    }
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn tauri_conf_uses_dark_bg_and_non_glob_resources() {
    let raw = fs::read_to_string("tauri.conf.json").expect("tauri.conf.json exists");
    let cfg: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
    assert_eq!(cfg["app"]["windows"][0]["backgroundColor"], "#0B0F17");
    let res = cfg["bundle"]["resources"].as_object().expect("bundle.resources map");
    assert_eq!(
        res.get("resources/python-analytics/").and_then(|v| v.as_str()),
        Some("python-analytics")
    );
    assert!(!res.keys().any(|k| k.contains('*')));
}
