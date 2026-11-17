use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::core::settings_store::{SettingsStore, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkReportRecord {
    pub id: String,
    pub model_name: String,
    pub context_length: u32,
    pub storage_media_kind: String,
    pub cold_load_ms: Option<f64>,
    pub warm_load_ms: Option<f64>,
    pub ttft_median_ms: Option<f64>,
    pub tok_per_sec_median: Option<f64>,
    pub peak_ram_bytes: Option<u64>,
    pub repetitions: u32,
    pub raw_report_json: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct BenchmarkInput {
    pub model_name: String,
    pub context_length: u32,
    pub storage_media_kind: String,
    pub cold_load_ms: Option<f64>,
    pub warm_load_ms: Option<f64>,
    pub ttft_median_ms: Option<f64>,
    pub tok_per_sec_median: Option<f64>,
    pub peak_ram_bytes: Option<u64>,
    pub repetitions: u32,
    pub raw_report_json: String,
}

pub fn save_benchmark_report(
    store: &SettingsStore,
    input: &BenchmarkInput,
) -> Result<BenchmarkReportRecord, StoreError> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO benchmark_reports (
                id, device_profile_id, volume_id, model_name, model_digest,
                quantization, context_length, ollama_version, storage_media_kind,
                cold_load_ms, warm_load_ms, ttft_median_ms, tok_per_sec_median,
                peak_ram_bytes, repetitions, raw_report_json, created_at
             ) VALUES (?1, NULL, NULL, ?2, NULL, NULL, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                input.model_name,
                i64::from(input.context_length),
                input.storage_media_kind,
                input.cold_load_ms,
                input.warm_load_ms,
                input.ttft_median_ms,
                input.tok_per_sec_median,
                input.peak_ram_bytes.map(|b| b as i64),
                i64::from(input.repetitions),
                input.raw_report_json,
                now,
            ],
        )?;
        Ok(())
    })?;

    Ok(BenchmarkReportRecord {
        id,
        model_name: input.model_name.clone(),
        context_length: input.context_length,
        storage_media_kind: input.storage_media_kind.clone(),
        cold_load_ms: input.cold_load_ms,
        warm_load_ms: input.warm_load_ms,
        ttft_median_ms: input.ttft_median_ms,
        tok_per_sec_median: input.tok_per_sec_median,
        peak_ram_bytes: input.peak_ram_bytes,
        repetitions: input.repetitions,
        raw_report_json: input.raw_report_json.clone(),
        created_at: now,
    })
}

pub fn list_benchmark_reports(
    store: &SettingsStore,
    limit: usize,
) -> Result<Vec<BenchmarkReportRecord>, StoreError> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, model_name, context_length, storage_media_kind,
                    cold_load_ms, warm_load_ms, ttft_median_ms, tok_per_sec_median,
                    peak_ram_bytes, repetitions, raw_report_json, created_at
             FROM benchmark_reports
             ORDER BY created_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(BenchmarkReportRecord {
                id: row.get(0)?,
                model_name: row.get(1)?,
                context_length: row.get::<_, i64>(2)? as u32,
                storage_media_kind: row.get(3)?,
                cold_load_ms: row.get(4)?,
                warm_load_ms: row.get(5)?,
                ttft_median_ms: row.get(6)?,
                tok_per_sec_median: row.get(7)?,
                peak_ram_bytes: row.get::<_, Option<i64>>(8)?.map(|v| v as u64),
                repetitions: row.get::<_, i64>(9)? as u32,
                raw_report_json: row.get(10)?,
                created_at: row.get(11)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

pub fn get_benchmark_report(
    store: &SettingsStore,
    id: &str,
) -> Result<Option<BenchmarkReportRecord>, StoreError> {
    use rusqlite::OptionalExtension;
    store.with_conn(|conn| {
        conn.query_row(
            "SELECT id, model_name, context_length, storage_media_kind,
                    cold_load_ms, warm_load_ms, ttft_median_ms, tok_per_sec_median,
                    peak_ram_bytes, repetitions, raw_report_json, created_at
             FROM benchmark_reports
             WHERE id = ?1",
            params![id],
            |row| {
                Ok(BenchmarkReportRecord {
                    id: row.get(0)?,
                    model_name: row.get(1)?,
                    context_length: row.get::<_, i64>(2)? as u32,
                    storage_media_kind: row.get(3)?,
                    cold_load_ms: row.get(4)?,
                    warm_load_ms: row.get(5)?,
                    ttft_median_ms: row.get(6)?,
                    tok_per_sec_median: row.get(7)?,
                    peak_ram_bytes: row.get::<_, Option<i64>>(8)?.map(|v| v as u64),
                    repetitions: row.get::<_, i64>(9)? as u32,
                    raw_report_json: row.get(10)?,
                    created_at: row.get(11)?,
                })
            },
        )
        .optional()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn benchmark_report_roundtrip() {
        let store = SettingsStore::open_in_memory().unwrap();
        let saved = save_benchmark_report(
            &store,
            &BenchmarkInput {
                model_name: "llama3.2:3b".into(),
                context_length: 4096,
                storage_media_kind: "HDD".into(),
                cold_load_ms: Some(51614.4),
                warm_load_ms: Some(0.5),
                ttft_median_ms: Some(102.9),
                tok_per_sec_median: Some(40.65),
                peak_ram_bytes: Some(7_577_108_480),
                repetitions: 2,
                raw_report_json: "{}".into(),
            },
        )
        .unwrap();
        let list = list_benchmark_reports(&store, 10).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, saved.id);
        assert!(get_benchmark_report(&store, &saved.id).unwrap().is_some());
    }
}
