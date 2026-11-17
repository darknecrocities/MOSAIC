CREATE TABLE IF NOT EXISTS cluster_workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    vram_bytes INTEGER NOT NULL DEFAULT 0,
    ram_available_bytes INTEGER NOT NULL DEFAULT 0,
    backend TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'configured',
    rtt_ms REAL,
    created_at TEXT NOT NULL,
    UNIQUE(host, port)
);
