use std::sync::{Arc, Mutex};
use std::time::Duration;

use mosaic_lib::core::download_manager::{DownloadRegistry, PullProgressEvent};
use mosaic_lib::core::inference_manager::{
    ChatMessage, ChatStreamRequest, ChatTokenEvent, InferenceRegistry,
};
use mosaic_lib::core::settings_store::ActiveLibraryRecord;
use tokio::net::TcpListener;

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

fn sample_req(session_id: &str) -> ChatStreamRequest {
    ChatStreamRequest {
        session_id: session_id.into(),
        model: "qwen3:30b-a3b".into(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
        }],
        num_ctx: Some(4096),
        temperature: Some(0.2),
        execution_profile: None,
        kv_cache_type: None,
        num_gpu: None,
        num_batch: None,
        num_ubatch: None,
        num_thread: None,
        use_mmap: None,
        use_mlock: None,
        keep_alive: None,
    }
}

async fn spawn_silent_header_stall_server() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let _hold = socket;
                tokio::time::sleep(Duration::from_secs(10)).await;
            });
        }
    });
    addr
}

#[tokio::test]
async fn pre_header_tcp_stall_times_out_emits_done_error_and_clears_active_state() {
    let addr = spawn_silent_header_stall_server().await;

    let dreg = DownloadRegistry::default();
    let d_evs: Arc<Mutex<Vec<PullProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let d_sink = d_evs.clone();
    dreg.start_pull_with_sink_and_timeout(
        format!("http://{addr}"),
        "qwen3:30b-a3b".into(),
        None,
        Some(active_lib()),
        true,
        Duration::from_millis(80),
        move |ev| d_sink.lock().unwrap().push(ev),
    )
    .unwrap();

    tokio::time::sleep(Duration::from_millis(320)).await;
    assert!(!dreg.has_active(), "pull registry must clear on pre-header timeout");
    let d_list = d_evs.lock().unwrap().clone();
    let d_last = d_list.last().expect("terminal pull event on pre-header stall");
    assert!(d_last.done && d_last.status == "error");
    assert!(d_last.error.as_deref().unwrap_or("").contains("timed out"));

    let ireg = InferenceRegistry::default();
    let c_evs: Arc<Mutex<Vec<ChatTokenEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let c_sink = c_evs.clone();
    ireg.start_chat_with_sink_and_timeout(
        format!("http://{addr}"),
        sample_req("s-prehdr-timeout"),
        true,
        Duration::from_millis(80),
        move |ev| c_sink.lock().unwrap().push(ev),
    )
    .unwrap();

    tokio::time::sleep(Duration::from_millis(320)).await;
    assert!(!ireg.is_running(), "chat registry must clear on pre-header timeout");
    let c_list = c_evs.lock().unwrap().clone();
    let c_last = c_list.last().expect("terminal chat event on pre-header stall");
    assert!(c_last.done);
    assert!(c_last.error.as_deref().unwrap_or("").contains("timed out"));
}

#[tokio::test]
async fn pre_header_tcp_stall_allows_cooperative_cancel_with_done_event() {
    let addr = spawn_silent_header_stall_server().await;

    let dreg = DownloadRegistry::default();
    let d_evs: Arc<Mutex<Vec<PullProgressEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let d_sink = d_evs.clone();
    dreg.start_pull_with_sink_and_timeout(
        format!("http://{addr}"),
        "qwen3:30b-a3b".into(),
        None,
        Some(active_lib()),
        true,
        Duration::from_secs(5),
        move |ev| d_sink.lock().unwrap().push(ev),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(dreg.cancel("qwen3:30b-a3b"));
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert!(!dreg.has_active());
    let d_last = d_evs.lock().unwrap().last().cloned().expect("cancelled pull event");
    assert!(d_last.done && d_last.status == "cancelled");

    let ireg = InferenceRegistry::default();
    let c_evs: Arc<Mutex<Vec<ChatTokenEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let c_sink = c_evs.clone();
    ireg.start_chat_with_sink_and_timeout(
        format!("http://{addr}"),
        sample_req("s-prehdr-cancel"),
        true,
        Duration::from_secs(5),
        move |ev| c_sink.lock().unwrap().push(ev),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(ireg.stop_active());
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert!(!ireg.is_running());
    let c_last = c_evs.lock().unwrap().last().cloned().expect("cancelled chat event");
    assert!(c_last.done && c_last.error.is_none());
}
