use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub use crate::core::settings_policy::AppSettingsSnapshot;
use crate::core::settings_policy::{apply_setting_row, validate_setting};
use crate::core::system_probe::SystemProfile;
use crate::core::volume_manager::{ExternalVolume, LibraryValidationResult};

const INITIAL_MIGRATION: &str = include_str!("../../migrations/0001_initial.sql");
const CLUSTER_MIGRATION: &str = include_str!("../../migrations/0002_cluster.sql");
const CATALOG_SNAPSHOT_KEY: &str = "catalog_snapshot_json";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid setting: {0}")]
    InvalidSetting(String),
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
        let gpu_json = serde_json::to_string(&profile.gpus)?;
        let phys = profile.physical_cores.map(|c| c as i64);
        let unified = if profile.is_unified_memory { 1_i64 } else { 0_i64 };

        let latest = conn
            .query_row(
                "SELECT id, os, os_build, architecture, cpu_model, cores_physical,
                        cores_logical, ram_total_bytes, is_unified_memory, gpu_info_json
                 FROM device_profiles ORDER BY detected_at DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        (
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Option<i64>>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                            row.get::<_, String>(9)?,
                        ),
                    ))
                },
            )
            .optional()?;

        let expected = (
            profile.os_name.clone(),
            profile.os_version.clone(),
            profile.architecture.clone(),
            profile.cpu_brand.clone(),
            phys,
            profile.logical_cores as i64,
            profile.ram_total_bytes as i64,
            unified,
            gpu_json.clone(),
        );

        let target_id = match latest {
            Some((id, fp)) if fp == expected => {
                conn.execute(
                    "UPDATE device_profiles SET ram_available_bytes = ?1, detected_at = ?2 WHERE id = ?3",
                    params![profile.ram_available_bytes as i64, profile.detected_at, id],
                )?;
                id
            }
            _ => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO device_profiles (
                        id, os, os_build, architecture, cpu_model, cores_physical,
                        cores_logical, ram_total_bytes, ram_available_bytes,
                        is_unified_memory, gpu_info_json, detected_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        id, profile.os_name, profile.os_version, profile.architecture,
                        profile.cpu_brand, phys, profile.logical_cores as i64,
                        profile.ram_total_bytes as i64, profile.ram_available_bytes as i64,
                        unified, gpu_json, profile.detected_at,
                    ],
                )?;
                id
            }
        };

        conn.execute(
            "DELETE FROM device_profiles
             WHERE id NOT IN (SELECT id FROM device_profiles ORDER BY detected_at DESC LIMIT 20)
               AND id NOT IN (SELECT device_profile_id FROM benchmark_reports WHERE device_profile_id IS NOT NULL)",
            [],
        )?;
        Ok(target_id)
    }

    pub fn latest_device_profile_id(&self) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.query_row(
            "SELECT id FROM device_profiles ORDER BY detected_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn active_volume_db_id(&self) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.query_row(
            "SELECT volume_id FROM model_libraries ORDER BY verified_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
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
                label = excluded.label, mount_path = excluded.mount_path,
                filesystem = excluded.filesystem, protocol = excluded.protocol,
                media_kind = excluded.media_kind, total_bytes = excluded.total_bytes,
                free_bytes = excluded.free_bytes, write_mb_s = excluded.write_mb_s,
                status = 'ready', last_verified_at = excluded.last_verified_at",
            params![
                vol_id, volume.volume_identifier, volume.label, volume.mount_path,
                volume.filesystem, volume.protocol, volume.media_kind,
                volume.total_bytes as i64, volume.free_bytes as i64,
                validation.probe_write_mb_s, now,
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

    pub fn mark_ollama_configured(&self, backup_path: Option<&str>) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.execute(
            "UPDATE model_libraries
             SET ollama_configured = 1,
                 config_backup_path = COALESCE(?1, config_backup_path)",
            params![backup_path],
        )?;
        Ok(())
    }

    pub fn get_active_library(&self) -> Result<Option<ActiveLibraryRecord>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.query_row(
            "SELECT sv.volume_identifier, sv.label, sv.mount_path, sv.filesystem,
                    sv.media_kind, ml.directory_path, ml.ollama_configured,
                    sv.free_bytes, sv.total_bytes, ml.verified_at
             FROM model_libraries ml
             JOIN storage_volumes sv ON sv.id = ml.volume_id
             ORDER BY ml.verified_at DESC LIMIT 1",
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
        .optional()
        .map_err(Into::into)
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
            apply_setting_row(&mut settings, &key, &val_json);
        }
        Ok(settings)
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<(), StoreError> {
        let normalized = validate_setting(key, value)?;
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let now = chrono::Utc::now().to_rfc3339();
        let val_json = serde_json::to_string(&normalized)?;
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, val_json, now],
        )?;
        Ok(())
    }

    pub fn save_catalog_snapshot_json(&self, snapshot_json: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![CATALOG_SNAPSHOT_KEY, snapshot_json, now],
        )?;
        Ok(())
    }

    pub fn load_catalog_snapshot_json(&self) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            params![CATALOG_SNAPSHOT_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T, StoreError>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        f(&conn).map_err(Into::into)
    }
}
