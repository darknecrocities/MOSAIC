use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::core::system_probe::SystemProfile;
use crate::core::volume_manager::{ExternalVolume, LibraryValidationResult};

const INITIAL_MIGRATION: &str = include_str!("../../migrations/0001_initial.sql");
const CLUSTER_MIGRATION: &str = include_str!("../../migrations/0002_cluster.sql");

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("store lock poisoned")]
    LockPoisoned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveLibraryRecord {
    pub volume_identifier: String,
    pub label: String,
    pub mount_path: String,
    pub filesystem: String,
    pub media_kind: String,
    pub directory_path: String,
    pub ollama_configured: bool,
    pub free_bytes: u64,
    pub total_bytes: u64,
    pub verified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEntry {
    pub id: String,
    pub severity: String,
    pub component: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettingsSnapshot {
    pub safety_reserve_gib: f64,
    pub ollama_endpoint: String,
    pub telemetry_poll_ms: u64,
    pub ollama_management_mode: String,
}

impl Default for AppSettingsSnapshot {
    fn default() -> Self {
        Self {
            safety_reserve_gib: 2.0,
            ollama_endpoint: "http://127.0.0.1:11434".to_string(),
            telemetry_poll_ms: 2500,
            ollama_management_mode: "managed_or_detected".to_string(),
        }
    }
}

pub struct SettingsStore {
    conn: Mutex<Connection>,
}

impl SettingsStore {
    pub fn open(db_path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(INITIAL_MIGRATION)?;
        conn.execute_batch(CLUSTER_MIGRATION)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(INITIAL_MIGRATION)?;
        conn.execute_batch(CLUSTER_MIGRATION)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn record_device_profile(&self, profile: &SystemProfile) -> Result<String, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let id = Uuid::new_v4().to_string();
        let gpu_json = serde_json::to_string(&profile.gpus)?;
        conn.execute(
            "INSERT INTO device_profiles (
                id, os, os_build, architecture, cpu_model, cores_physical,
                cores_logical, ram_total_bytes, ram_available_bytes,
                is_unified_memory, gpu_info_json, detected_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                profile.os_name,
                profile.os_version,
                profile.architecture,
                profile.cpu_brand,
                profile.physical_cores.map(|c| c as i64),
                profile.logical_cores as i64,
                profile.ram_total_bytes as i64,
                profile.ram_available_bytes as i64,
                if profile.is_unified_memory { 1 } else { 0 },
                gpu_json,
                profile.detected_at,
            ],
        )?;
        Ok(id)
    }

    pub fn save_active_library(
        &self,
        volume: &ExternalVolume,
        validation: &LibraryValidationResult,
    ) -> Result<ActiveLibraryRecord, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let now = chrono::Utc::now().to_rfc3339();
        let vol_id = Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO storage_volumes (
                id, volume_identifier, label, mount_path, filesystem, protocol,
                media_kind, total_bytes, free_bytes, read_mb_s, write_mb_s,
                status, last_verified_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, 'ready', ?11)
             ON CONFLICT(volume_identifier) DO UPDATE SET
                label = excluded.label,
                mount_path = excluded.mount_path,
                filesystem = excluded.filesystem,
                protocol = excluded.protocol,
                media_kind = excluded.media_kind,
                total_bytes = excluded.total_bytes,
                free_bytes = excluded.free_bytes,
                write_mb_s = excluded.write_mb_s,
                status = 'ready',
                last_verified_at = excluded.last_verified_at",
            params![
                vol_id,
                volume.volume_identifier,
                volume.label,
                volume.mount_path,
                volume.filesystem,
                volume.protocol,
                volume.media_kind,
                volume.total_bytes as i64,
                volume.free_bytes as i64,
                validation.probe_write_mb_s,
                now,
            ],
        )?;

        let stored_vol_id: String = conn.query_row(
            "SELECT id FROM storage_volumes WHERE volume_identifier = ?1",
            params![volume.volume_identifier],
            |row| row.get(0),
        )?;

        let lib_id = Uuid::new_v4().to_string();
        conn.execute("DELETE FROM model_libraries", [])?;
        conn.execute(
            "INSERT INTO model_libraries (
                id, volume_id, directory_path, ollama_configured, config_backup_path, verified_at
             ) VALUES (?1, ?2, ?3, 0, NULL, ?4)",
            params![lib_id, stored_vol_id, validation.library_path, now],
        )?;

        Ok(ActiveLibraryRecord {
            volume_identifier: volume.volume_identifier.clone(),
            label: volume.label.clone(),
            mount_path: volume.mount_path.clone(),
            filesystem: volume.filesystem.clone(),
            media_kind: volume.media_kind.clone(),
            directory_path: validation.library_path.clone(),
            ollama_configured: false,
            free_bytes: volume.free_bytes,
            total_bytes: volume.total_bytes,
            verified_at: now,
        })
    }

    pub fn get_active_library(&self) -> Result<Option<ActiveLibraryRecord>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let record = conn
            .query_row(
                "SELECT sv.volume_identifier, sv.label, sv.mount_path, sv.filesystem,
                        sv.media_kind, ml.directory_path, ml.ollama_configured,
                        sv.free_bytes, sv.total_bytes, ml.verified_at
                 FROM model_libraries ml
                 JOIN storage_volumes sv ON sv.id = ml.volume_id
                 ORDER BY ml.verified_at DESC
                 LIMIT 1",
                [],
                |row| {
                    Ok(ActiveLibraryRecord {
                        volume_identifier: row.get(0)?,
                        label: row.get(1)?,
                        mount_path: row.get(2)?,
                        filesystem: row.get(3)?,
                        media_kind: row.get(4)?,
                        directory_path: row.get(5)?,
                        ollama_configured: row.get::<_, i64>(6)? != 0,
                        free_bytes: row.get::<_, i64>(7)? as u64,
                        total_bytes: row.get::<_, i64>(8)? as u64,
                        verified_at: row.get(9)?,
                    })
                },
            )
            .optional()?;
        Ok(record)
    }

    pub fn get_settings(&self) -> Result<AppSettingsSnapshot, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let mut settings = AppSettingsSnapshot::default();

        let mut stmt = conn.prepare("SELECT key, value_json FROM app_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            let (key, val_json) = row?;
            match key.as_str() {
                "safety_reserve_gib" => {
                    if let Ok(v) = serde_json::from_str::<f64>(&val_json) {
                        settings.safety_reserve_gib = v.clamp(0.5, 16.0);
                    }
                }
                "ollama_endpoint" => {
                    if let Ok(v) = serde_json::from_str::<String>(&val_json) {
                        settings.ollama_endpoint = v;
                    }
                }
                "telemetry_poll_ms" => {
                    if let Ok(v) = serde_json::from_str::<u64>(&val_json) {
                        settings.telemetry_poll_ms = v.clamp(500, 30_000);
                    }
                }
                "ollama_management_mode" => {
                    if let Ok(v) = serde_json::from_str::<String>(&val_json) {
                        settings.ollama_management_mode = v;
                    }
                }
                _ => {}
            }
        }
        Ok(settings)
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let now = chrono::Utc::now().to_rfc3339();
        let val_json = serde_json::to_string(value)?;
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at",
            params![key, val_json, now],
        )?;
        Ok(())
    }

    pub fn log_diagnostic(
        &self,
        severity: &str,
        component: &str,
        message: &str,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO diagnostic_events (id, severity, component, message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, severity, component, message, now],
        )?;
        Ok(())
    }

    pub fn list_diagnostics(&self, limit: usize) -> Result<Vec<DiagnosticEntry>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
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
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T, StoreError>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        f(&conn).map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_library_roundtrip_parameterized() {
        let store = SettingsStore::open_in_memory().unwrap();
        assert!(store.get_active_library().unwrap().is_none());

        let vol = ExternalVolume {
            volume_identifier: "UUID-123".into(),
            label: "MOSAIC_SSD".into(),
            mount_path: "/Volumes/MOSAIC_SSD".into(),
            filesystem: "APFS".into(),
            protocol: "USB".into(),
            media_kind: "SSD".into(),
            total_bytes: 1_000_000_000,
            free_bytes: 750_000_000,
            writable: true,
            advisory: None,
        };
        let val = LibraryValidationResult {
            volume_identifier: "UUID-123".into(),
            library_path: "/Volumes/MOSAIC_SSD/MOSAIC/ollama-models".into(),
            writable: true,
            free_bytes: 750_000_000,
            probe_write_mb_s: 420.5,
        };

        store.save_active_library(&vol, &val).unwrap();
        let active = store.get_active_library().unwrap().unwrap();
        assert_eq!(active.volume_identifier, "UUID-123");
        assert_eq!(active.media_kind, "SSD");

        store
            .set_setting("safety_reserve_gib", &serde_json::json!(3.5))
            .unwrap();
        assert_eq!(store.get_settings().unwrap().safety_reserve_gib, 3.5);
    }
}
