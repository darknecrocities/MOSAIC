use std::sync::{Arc, Mutex};
use std::time::Duration;

use mosaic_lib::core::download_manager::{DownloadError, DownloadRegistry, PullProgressEvent};
use mosaic_lib::core::inference_manager::{ChatMessage, ChatStreamRequest, ChatTokenEvent, InferenceRegistry};
use mosaic_lib::core::model_library;
use mosaic_lib::core::ollama_supervisor::OllamaSupervisor;
use mosaic_lib::core::settings_store::{ActiveLibraryRecord, AppSettingsSnapshot, SettingsStore};
use mosaic_lib::core::system_probe::SystemProfile;
use mosaic_lib::core::{benchmark_store, telemetry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn sample_sys(ram_avail: u64, cpu: &str) -> SystemProfile {
    SystemProfile {
        os_name: "Darwin".into(),
        os_version: "15.0".into(),
        architecture: "aarch64".into(),
        cpu_brand: cpu.into(),
        physical_cores: Some(8),
        logical_cores: 8,
        ram_total_bytes: 16 * 1024_u64.pow(3),
        ram_available_bytes: ram_avail,
        is_unified_memory: true,
        metal_wired_limit_bytes: None,
        gpus: vec![],
        gpu_status: "unified_memory".into(),
        detected_at: "2026-11-18T00:00:00Z".into(),
    }
}

fn active_lib() -> ActiveLibraryRecord {
    ActiveLibraryRecord {
        volume_identifier: "VOL-1".into(),
        label: "OneTouch".into(),
        mount_path: "/Volumes/OneTouch".into(),
        filesystem: "exFAT".into(),
        media_kind: "HDD".into(),
        directory_path: "/Volumes/OneTouch/MOSAIC/ollama-models".into(),
        ollama_configured: true,
        free_bytes: 500 * 1024_u64.pow(3),
        total_bytes: 1000 * 1024_u64.pow(3),
        verified_at: "2026-11-18T00:00:00Z".into(),
    }
}

#[tokio::test]
async fn download_registry_cooperative_cancel_and_dup_guard() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0_u8; 1024];
            let _ = sock.read(&mut buf).await;
            let body = "{\"status\":\"pulling manifest\"}\n";
            let hdr = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n";
            let chunk = format!("{:x}\r\n{body}\r\n", body.len());
            let _ = sock.write_all(hdr.as_bytes()).await;
            let _ = sock.write_all(chunk.as_bytes()).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    let reg = DownloadRegistry::default();
    let events: Arc<Mutex<Vec<PullProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let endpoint = format!("http://{addr}");

    reg.start_pull_with_sink(
        endpoint.clone(),
        "llama3.2:1b".into(),
        Some(1_000_000_000),
        Some(active_lib()),
        true,
        move |ev| sink_events.lock().unwrap().push(ev),
    )
    .unwrap();

    let dup = reg.start_pull_with_sink(
        endpoint,
        "llama3.2:1b".into(),
        Some(1_000_000_000),
        Some(active_lib()),
        true,
        |_| {},
    );
    assert!(matches!(dup, Err(DownloadError::AlreadyInProgress(_))));

    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(reg.cancel("llama3.2:1b"));

    tokio::time::sleep(Duration::from_millis(120)).await;
    let recorded = events.lock().unwrap().clone();
    let terminal = recorded.last().expect("expected terminal pull event");
    assert!(terminal.done);
    assert_eq!(terminal.status, "cancelled");
    assert_eq!(terminal.error.as_deref(), Some("Pull cancelled by user."));
    assert!(!reg.has_active());
}

#[tokio::test]
async fn inference_registry_cooperative_stop_and_adaptive_payload() {
    let legacy: ChatStreamRequest = serde_json::from_value(serde_json::json!({
        "session_id": "s0",
        "model": "llama3.2:1b",
        "messages": [{"role": "user", "content": "hi"}],
        "num_ctx": 4096,
        "temperature": 0.2
    }))
    .unwrap();
    assert!(legacy.num_batch.is_none());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = Arc::new(Mutex::new(String::new()));
    let cap_srv = captured.clone();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0_u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            *cap_srv.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = "{\"message\":{\"role\":\"assistant\",\"content\":\"Hel\"},\"done\":false}\n";
            let hdr = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n";
            let chunk = format!("{:x}\r\n{body}\r\n", body.len());
            let _ = sock.write_all(hdr.as_bytes()).await;
            let _ = sock.write_all(chunk.as_bytes()).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    let reg = InferenceRegistry::default();
    let events: Arc<Mutex<Vec<ChatTokenEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_ev = events.clone();
    let req = ChatStreamRequest {
        session_id: "sess-1".into(),
        model: "qwen3:30b-a3b".into(),
        messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
        num_ctx: Some(8192),
        temperature: Some(0.1),
        execution_profile: Some("constrained_memory".into()),
        kv_cache_type: Some("q4_0".into()),
        num_gpu: Some(24),
        num_batch: Some(128),
        num_ubatch: Some(64),
        num_thread: Some(8),
        use_mmap: Some(true),
        use_mlock: Some(false),
        keep_alive: Some("30s".into()),
    };
    reg.start_chat_with_sink(format!("http://{addr}"), req, true, move |ev| {
        sink_ev.lock().unwrap().push(ev);
    })
    .unwrap();

    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(reg.stop_active());
    tokio::time::sleep(Duration::from_millis(120)).await;

    let raw_req = captured.lock().unwrap().clone();
    assert!(raw_req.contains("\"num_gpu\":24"));
    assert!(raw_req.contains("\"num_batch\":128"));
    assert!(raw_req.contains("\"keep_alive\":\"30s\""));
    let evs = events.lock().unwrap().clone();
    let last = evs.last().expect("expected terminal chat event");
    assert!(last.done);
    assert!(last.error.is_none());
}

#[tokio::test]
async fn show_model_details_and_supervisor_gates() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0_u8; 1024];
            let _ = sock.read(&mut buf).await;
            let body = r#"{"license":"Apache-2.0","details":{"family":"qwen3","parameter_size":"30.5B","quantization_level":"IQ2_XS"},"capabilities":["completion","tools"]}"#;
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
        }
    });

    let details = model_library::show_model_details(&format!("http://{addr}"), "qwen3:30b-a3b")
        .await
        .unwrap();
    assert_eq!(details.details.unwrap().quantization_level.as_deref(), Some("IQ2_XS"));
    assert!(model_library::show_model_details(&format!("http://{addr}"), "../bad").await.is_err());

    let sup = OllamaSupervisor::default();
    let settings = AppSettingsSnapshot::default();
    let sys = sample_sys(8 * 1024_u64.pow(3), "Apple M3");
    assert!(sup.start_managed("http://127.0.0.1:11434", "/tmp/m", &settings, &sys, false).await.is_err());
    assert!(sup.stop_managed("http://127.0.0.1:11434", false).await.is_err());
}

#[test]
fn device_profiles_dedup_and_fk_safe_prune_and_diagnostics() {
    let store = SettingsStore::open_in_memory().unwrap();
    let first_id = store.record_device_profile(&sample_sys(4_000_000_000, "Apple M3")).unwrap();
    for i in 0..10 {
        let id = store.record_device_profile(&sample_sys(4_000_000_000 + i * 1024, "Apple M3")).unwrap();
        assert_eq!(id, first_id);
    }
    let count: i64 = store
        .with_conn(|c| c.query_row("SELECT COUNT(*) FROM device_profiles", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(count, 1);

    benchmark_store::save_benchmark_report(
        &store,
        &benchmark_store::BenchmarkInput {
            device_profile_id: Some(first_id.clone()),
            model_name: "llama3.2:1b".into(),
            context_length: 4096,
            storage_media_kind: "SSD".into(),
            repetitions: 2,
            raw_report_json: "{}".into(),
            ..Default::default()
        },
    )
    .unwrap();

    for i in 0..25 {
        let mut p = sample_sys(4_000_000_000, &format!("CPU-{i}"));
        p.detected_at = format!("2026-11-18T00:00:{:02}Z", i);
        store.record_device_profile(&p).unwrap();
    }
    let pinned_exists: i64 = store
        .with_conn(|c| c.query_row("SELECT COUNT(*) FROM device_profiles WHERE id = ?1", [first_id], |r| r.get(0)))
        .unwrap();
    assert_eq!(pinned_exists, 1);

    telemetry::log_diagnostic(&store, "info", "test", "hello diag").unwrap();
    let diags = telemetry::list_diagnostics(&store, 10).unwrap();
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].message, "hello diag");
}
