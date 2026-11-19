use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mosaic_lib::commands::runtime_state::RuntimeState;
use mosaic_lib::core::catalog_security::{
    build_catalog_client, read_response_bounded, MAX_CATALOG_BYTES,
};
use mosaic_lib::core::cluster_flags::validate_worker_host;
use mosaic_lib::core::cluster_manager::ClusterRuntimeRegistry;
use mosaic_lib::core::download_manager::{DownloadRegistry, PullProgressEvent};
use mosaic_lib::core::inference_manager::{
    ChatMessage, ChatStreamRequest, ChatTokenEvent, InferenceRegistry,
};
use mosaic_lib::core::migration::{
    copy_internal_models, is_migration_active, MigrationActiveGuard,
};
use mosaic_lib::core::model_catalog;
use mosaic_lib::core::ollama_supervisor::{compute_adaptive_ollama_env, OllamaSupervisor};
use mosaic_lib::core::settings_store::{ActiveLibraryRecord, AppSettingsSnapshot};
use mosaic_lib::core::system_probe::SystemProfile;
use mosaic_lib::core::volume_parsers::parse_macos_storage_json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

static MIGRATION_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn active_lib() -> ActiveLibraryRecord {
    ActiveLibraryRecord {
        volume_identifier: "VOL-1".into(),
        label: "OneTouch".into(),
        mount_path: "/Volumes/OneTouch".into(),
        filesystem: "exFAT".into(),
        media_kind: "SSD".into(),
        directory_path: "/Volumes/OneTouch/MOSAIC/ollama-models".into(),
        ollama_configured: true,
        free_bytes: 500 * 1024_u64.pow(3),
        total_bytes: 1000 * 1024_u64.pow(3),
        verified_at: "2026-11-18T00:00:00Z".into(),
    }
}

fn sample_sys() -> SystemProfile {
    SystemProfile {
        os_name: "Darwin".into(),
        os_version: "15.0".into(),
        architecture: "aarch64".into(),
        cpu_brand: "Apple M3".into(),
        physical_cores: Some(8),
        logical_cores: 8,
        ram_total_bytes: 16 * 1024_u64.pow(3),
        ram_available_bytes: 12 * 1024_u64.pow(3),
        is_unified_memory: true,
        metal_wired_limit_bytes: Some(11 * 1024_u64.pow(3)),
        gpus: vec![],
        gpu_status: "unified_memory".into(),
        detected_at: "2026-11-18T00:00:00Z".into(),
    }
}

fn sample_req(session_id: &str) -> ChatStreamRequest {
    ChatStreamRequest {
        session_id: session_id.into(), model: "qwen3:30b-a3b".into(),
        messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
        num_ctx: Some(4096), temperature: Some(0.2), execution_profile: None,
        kv_cache_type: None, num_gpu: None, num_batch: None, num_ubatch: None,
        num_thread: None, use_mmap: None, use_mlock: None, keep_alive: None,
    }
}

async fn spawn_raw_http_server(chunks: Vec<Vec<u8>>, close_immediately: bool) -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0_u8; 2048];
            let _ = sock.read(&mut buf).await;
            let hdr = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n";
            let _ = sock.write_all(hdr.as_bytes()).await;
            for c in chunks {
                let frame = format!("{:x}\r\n", c.len());
                let _ = sock.write_all(frame.as_bytes()).await;
                let _ = sock.write_all(&c).await;
                let _ = sock.write_all(b"\r\n").await;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if close_immediately {
                let _ = sock.write_all(b"0\r\n\r\n").await;
            } else {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    });
    addr
}

#[tokio::test]
async fn download_registry_rejects_premature_eof_and_processes_trailing_non_newline_json() {
    let addr_eof = spawn_raw_http_server(
        vec![b"{\"status\":\"downloading\",\"completed\":500,\"total\":10000}\n".to_vec()],
        true,
    )
    .await;
    let reg = DownloadRegistry::default();
    let events_a: Arc<Mutex<Vec<PullProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_a = events_a.clone();
    reg.start_pull_with_sink(
        format!("http://{addr_eof}"), "qwen3:30b-a3b".into(), Some(10_000),
        Some(active_lib()), true, move |ev| sink_a.lock().unwrap().push(ev),
    ).unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let list_a = events_a.lock().unwrap().clone();
    let last_a = list_a.last().expect("terminal pull event on premature EOF");
    assert!(last_a.done && last_a.status == "error" && last_a.error.is_some());

    let addr_tail = spawn_raw_http_server(vec![b"{\"error\":\"model not found\"}".to_vec()], true).await;
    let events_b: Arc<Mutex<Vec<PullProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_b = events_b.clone();
    reg.start_pull_with_sink(
        format!("http://{addr_tail}"), "qwen3:30b-a3b".into(), Some(10_000),
        Some(active_lib()), true, move |ev| sink_b.lock().unwrap().push(ev),
    ).unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let list_b = events_b.lock().unwrap().clone();
    let last_b = list_b.last().expect("terminal pull event on trailing error json");
    assert!(last_b.done && last_b.status == "error");
    assert!(last_b.error.as_deref().unwrap_or("").contains("model not found"));
}

#[tokio::test]
async fn inference_registry_preserves_split_utf8_and_flushes_trailing_json_and_errors_on_eof_without_done() {
    let rocket = "🚀".as_bytes();
    let mut part1 = b"{\"message\":{\"role\":\"assistant\",\"content\":\"".to_vec();
    part1.extend_from_slice(&rocket[..2]);
    let mut part2 = rocket[2..].to_vec();
    part2.extend_from_slice(b"\"},\"done\":false}\n{\"message\":{\"role\":\"assistant\",\"content\":\"!\"},\"done\":true}");

    let addr_utf = spawn_raw_http_server(vec![part1, part2], true).await;
    let reg = InferenceRegistry::default();
    let req = sample_req("s-utf");
    let evs_utf: Arc<Mutex<Vec<ChatTokenEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_utf = evs_utf.clone();
    reg.start_chat_with_sink(format!("http://{addr_utf}"), req.clone(), true, move |ev| {
        sink_utf.lock().unwrap().push(ev);
    })
    .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let joined: String = evs_utf.lock().unwrap().iter().map(|e| e.token.as_str()).collect();
    assert_eq!(joined, "🚀!");
    assert!(evs_utf.lock().unwrap().last().is_some_and(|e| e.done && e.error.is_none()));

    let addr_trunc = spawn_raw_http_server(
        vec![b"{\"message\":{\"role\":\"assistant\",\"content\":\"half\"},\"done\":false}\n".to_vec()],
        true,
    )
    .await;
    let evs_trunc: Arc<Mutex<Vec<ChatTokenEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_trunc = evs_trunc.clone();
    reg.start_chat_with_sink(format!("http://{addr_trunc}"), req, true, move |ev| {
        sink_trunc.lock().unwrap().push(ev);
    })
    .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let last_trunc = evs_trunc.lock().unwrap().last().cloned().expect("EOF error event");
    assert!(last_trunc.done);
    assert!(last_trunc.error.is_some());
}

#[tokio::test]
async fn stream_pull_and_chat_enforce_chunk_read_timeout() {
    let addr_pull = spawn_raw_http_server(vec![b"{\"status\":\"pulling manifest\"}\n".to_vec()], false).await;
    let dreg = DownloadRegistry::default();
    let d_evs: Arc<Mutex<Vec<PullProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let d_sink = d_evs.clone();
    dreg.start_pull_with_sink_and_timeout(
        format!("http://{addr_pull}"), "qwen3:30b-a3b".into(), None, Some(active_lib()),
        true, Duration::from_millis(80), move |ev| d_sink.lock().unwrap().push(ev),
    ).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!dreg.has_active());
    let d_last = d_evs.lock().unwrap().last().cloned().expect("pull timeout event");
    assert!(d_last.done && d_last.status == "error" && d_last.error.unwrap_or_default().contains("timed out"));

    let addr_chat = spawn_raw_http_server(
        vec![b"{\"message\":{\"role\":\"assistant\",\"content\":\"hi\"},\"done\":false}\n".to_vec()],
        false,
    ).await;
    let ireg = InferenceRegistry::default();
    let c_evs: Arc<Mutex<Vec<ChatTokenEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let c_sink = c_evs.clone();
    ireg.start_chat_with_sink_and_timeout(
        format!("http://{addr_chat}"), sample_req("s-timeout"), true,
        Duration::from_millis(80), move |ev| c_sink.lock().unwrap().push(ev),
    ).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!ireg.is_running());
    let c_last = c_evs.lock().unwrap().last().cloned().expect("chat timeout event");
    assert!(c_last.done);
    assert!(c_last.error.unwrap_or_default().contains("timed out"));
}

#[tokio::test]
async fn refresh_catalog_https_blocks_ssrf_redirects_and_streaming_oversize() {
    let trap = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trap_addr = trap.local_addr().unwrap();
    let accepted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let acc_flag = accepted.clone();
    tokio::spawn(async move {
        if trap.accept().await.is_ok() {
            acc_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    });

    for url in [
        format!("https://127.0.0.1:{}/cat.json", trap_addr.port()),
        "https://[::1]/cat.json".into(),
        "https://localhost/cat.json".into(),
        "https://10.0.0.1/cat.json".into(),
        "https://169.254.169.254/latest".into(),
        "https://metadata.google.internal/cat.json".into(),
        "https://127.0.0.1.internal/cat.json".into(),
    ] {
        assert!(model_catalog::refresh_catalog_https(&url).await.is_err(), "must reject {url}");
    }
    assert!(!accepted.load(std::sync::atomic::Ordering::SeqCst), "SSRF socket must never accept()");

    let srv = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let srv_addr = srv.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = srv.accept().await {
            tokio::spawn(async move {
                let mut buf = [0_u8; 2048];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&buf[..n]);
                if req_str.contains("/redir") {
                    let _ = sock.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                } else {
                    let hdr = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                    let _ = sock.write_all(hdr.as_bytes()).await;
                    let chunk = vec![b'A'; 512 * 1024];
                    for _ in 0..5 {
                        let _ = sock.write_all(format!("{:x}\r\n", chunk.len()).as_bytes()).await;
                        let _ = sock.write_all(&chunk).await;
                        let _ = sock.write_all(b"\r\n").await;
                    }
                    let _ = sock.write_all(b"0\r\n\r\n").await;
                }
            });
        }
    });

    let client = build_catalog_client("127.0.0.1", &[]).unwrap();
    let r_redir = client.get(format!("http://{srv_addr}/redir")).send().await.unwrap();
    assert!(read_response_bounded(r_redir, MAX_CATALOG_BYTES).await.unwrap_err().contains("redirect"));

    let r_big = client.get(format!("http://{srv_addr}/big")).send().await.unwrap();
    assert!(read_response_bounded(r_big, MAX_CATALOG_BYTES).await.unwrap_err().contains("2 MiB"));
}

#[tokio::test]
async fn migration_atomic_overwrite_of_partial_blob_and_concurrency_guard() {
    let _mig_lock = MIGRATION_TEST_LOCK.lock().await;
    let base = std::env::temp_dir().join(format!("mosaic-adv-mig-{}", Uuid::new_v4()));
    let fake_home = base.join("home");
    let blobs = fake_home.join(".ollama/models/blobs");
    let dest = base.join("ext");
    fs::create_dir_all(&blobs).unwrap();
    fs::create_dir_all(dest.join("blobs")).unwrap();
    fs::write(blobs.join("sha256-abc"), vec![b'Z'; 1024]).unwrap();
    fs::write(dest.join("blobs/sha256-abc"), vec![b'X'; 10]).unwrap();

    let prev_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &fake_home);
    let res = copy_internal_models(&dest, 100_000, true).unwrap();
    assert_eq!(res.files_copied, 1);
    assert_eq!(res.bytes_copied, 1024);
    assert_eq!(fs::metadata(dest.join("blobs/sha256-abc")).unwrap().len(), 1024);

    let guard = MigrationActiveGuard::try_acquire().unwrap();
    assert!(is_migration_active());
    let err = copy_internal_models(&dest, 100_000, true).unwrap_err();
    assert!(err.contains("already in progress"));
    drop(guard);
    assert!(!is_migration_active());

    if let Some(p) = prev_home { std::env::set_var("HOME", p); } else { std::env::remove_var("HOME"); }
    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn prepare_safe_eject_blocks_active_benchmark_migration_and_cluster_runtime() {
    let _mig_lock = MIGRATION_TEST_LOCK.lock().await;
    let rt = RuntimeState::default();
    let cluster_rt = ClusterRuntimeRegistry::default();
    assert!(!rt.has_active_operations(&cluster_rt));

    {
        let _bench = rt.begin_benchmark();
        assert!(rt.has_active_operations(&cluster_rt));
    }
    assert!(!rt.has_active_operations(&cluster_rt));

    {
        let _mig = MigrationActiveGuard::try_acquire().unwrap();
        assert!(rt.has_active_operations(&cluster_rt));
    }
    assert!(!rt.has_active_operations(&cluster_rt));

    #[cfg(unix)]
    {
        let child = tokio::process::Command::new("sleep").arg("5").spawn().unwrap();
        cluster_rt.track_child(child);
        assert!(cluster_rt.is_running());
        assert!(rt.has_active_operations(&cluster_rt));
        assert!(cluster_rt.stop());
    }
}

#[test]
fn volume_parsers_and_cluster_flags_and_supervisor_env_drift() {
    let fixture = serde_json::json!({
        "SPStorageDataType": [{
            "_name": "One Touch", "mount_point": "/Volumes/One Touch",
            "file_system": "ExFAT", "writable": "yes", "volume_uuid": "",
            "size_in_bytes": 1_000_000u64, "free_space_in_bytes": 500_000u64,
            "physical_drive": { "is_internal_disk": "no", "protocol": "USB", "medium_type": "hdd" }
        }]
    });
    let vols = parse_macos_storage_json(&fixture);
    assert_eq!(vols.len(), 1);
    assert_eq!(vols[0].volume_identifier, "/Volumes/One Touch");

    assert!(validate_worker_host("0:0:0:0:0:0:0:1", false).is_ok());
    assert!(validate_worker_host("::ffff:127.0.0.1", false).is_ok());
    assert!(validate_worker_host("::ffff:169.254.169.254", true).is_err());

    let sup = OllamaSupervisor::default();
    let s1 = AppSettingsSnapshot { execution_profile: "balanced".into(), ..Default::default() };
    let e1 = compute_adaptive_ollama_env("http://127.0.0.1:11434", "/Volumes/OneTouch/m", &s1, &sample_sys()).unwrap();
    assert!(!sup.active_env_matches(&e1));
}
