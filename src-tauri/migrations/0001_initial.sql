PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS device_profiles (
    id TEXT PRIMARY KEY,
    os TEXT NOT NULL,
    os_build TEXT NOT NULL,
    architecture TEXT NOT NULL,
    cpu_model TEXT NOT NULL,
    cores_physical INTEGER,
    cores_logical INTEGER NOT NULL,
    ram_total_bytes INTEGER NOT NULL,
    ram_available_bytes INTEGER NOT NULL,
    is_unified_memory INTEGER NOT NULL DEFAULT 0,
    gpu_info_json TEXT NOT NULL,
    detected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_volumes (
    id TEXT PRIMARY KEY,
    volume_identifier TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    mount_path TEXT NOT NULL,
    filesystem TEXT NOT NULL,
    protocol TEXT NOT NULL,
    media_kind TEXT NOT NULL,
    total_bytes INTEGER NOT NULL,
    free_bytes INTEGER NOT NULL,
    read_mb_s REAL,
    write_mb_s REAL,
    status TEXT NOT NULL,
    last_verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_libraries (
    id TEXT PRIMARY KEY,
    volume_id TEXT NOT NULL REFERENCES storage_volumes(id) ON DELETE CASCADE,
    directory_path TEXT NOT NULL,
    ollama_configured INTEGER NOT NULL DEFAULT 0,
    config_backup_path TEXT,
    verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_records (
    id TEXT PRIMARY KEY,
    ollama_name TEXT NOT NULL,
    tag TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    digest TEXT,
    metadata_json TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE(ollama_name, tag)
);

CREATE TABLE IF NOT EXISTS model_assessments (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES model_records(id) ON DELETE CASCADE,
    fit_status TEXT NOT NULL,
    weight_memory_bytes INTEGER NOT NULL,
    runtime_overhead_bytes INTEGER NOT NULL,
    kv_cache_bytes INTEGER NOT NULL,
    available_budget_bytes INTEGER NOT NULL,
    context_assumption INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    explanation_json TEXT NOT NULL,
    assessed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_sessions (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES model_records(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    settings_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_reports (
    id TEXT PRIMARY KEY,
    device_profile_id TEXT REFERENCES device_profiles(id),
    volume_id TEXT REFERENCES storage_volumes(id),
    model_name TEXT NOT NULL,
    model_digest TEXT,
    quantization TEXT,
    context_length INTEGER NOT NULL,
    ollama_version TEXT,
    storage_media_kind TEXT NOT NULL,
    cold_load_ms REAL,
    warm_load_ms REAL,
    ttft_median_ms REAL,
    tok_per_sec_median REAL,
    peak_ram_bytes INTEGER,
    repetitions INTEGER NOT NULL,
    raw_report_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnostic_events (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL,
    component TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);
