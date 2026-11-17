use std::fs;

#[test]
fn tauri_csp_forbids_unsafe_directives_and_non_loopback_connect() {
    let raw = fs::read_to_string("tauri.conf.json").expect("tauri.conf.json exists");
    let cfg: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
    let csp = cfg["app"]["security"]["csp"]
        .as_str()
        .expect("csp configured");

    assert!(csp.contains("default-src 'self'"));
    assert!(!csp.contains("unsafe-inline"));
    assert!(!csp.contains("unsafe-eval"));
    assert!(csp.contains("http://127.0.0.1:11434"));
    assert!(!csp.contains("0.0.0.0"));
}

#[test]
fn initial_migration_does_not_create_chat_history_table() {
    let sql = fs::read_to_string("migrations/0001_initial.sql").expect("migration exists");
    let lower = sql.to_ascii_lowercase();
    assert!(!lower.contains("chat_messages"));
    assert!(!lower.contains("conversation_history"));
}
