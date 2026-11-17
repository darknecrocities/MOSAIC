use rusqlite::params;
use serde::{Deserialize, Serialize};
use sysinfo::System;
use uuid::Uuid;

use crate::core::settings_store::{SettingsStore, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEntry {
    pub id: String,
    pub severity: String,
    pub component: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceTelemetry {
    pub cpu_usage_percent: f32,
    pub ram_total_bytes: u64,
    pub ram_available_bytes: u64,
    pub ram_used_bytes: u64,
    pub sampled_at: String,
}

pub fn sample_resources() -> ResourceTelemetry {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();

    let total = sys.total_memory();
    let used = sys.used_memory();
    let available = match sys.available_memory() {
        0 => total.saturating_sub(used),
        avail => avail,
    };

    ResourceTelemetry {
        cpu_usage_percent: (sys.global_cpu_usage() * 10.0).round() / 10.0,
        ram_total_bytes: total,
        ram_available_bytes: available,
        ram_used_bytes: used,
        sampled_at: chrono::Utc::now().to_rfc3339(),
    }
}

pub fn log_diagnostic(
    store: &SettingsStore,
    severity: &str,
    component: &str,
    message: &str,
) -> Result<(), StoreError> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO diagnostic_events (id, severity, component, message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, severity, component, message, now],
        )?;
        Ok(())
    })
}

pub fn list_diagnostics(
    store: &SettingsStore,
    limit: usize,
) -> Result<Vec<DiagnosticEntry>, StoreError> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, severity, component, message, created_at
             FROM diagnostic_events
             ORDER BY created_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(DiagnosticEntry {
                id: row.get(0)?,
                severity: row.get(1)?,
                component: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_resources_returns_valid_memory() {
        let sample = sample_resources();
        assert!(sample.ram_total_bytes > 0);
        assert!(sample.ram_available_bytes <= sample.ram_total_bytes);
    }
}
