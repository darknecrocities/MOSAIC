use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::core::settings_store::{SettingsStore, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkReportRecord {
    pub id: String,
    #[serde(default)]
    pub device_profile_id: Option<String>,
    #[serde(default)]
    pub volume_id: Option<String>,
    pub model_name: String,
    #[serde(default)]
    pub model_digest: Option<String>,
    #[serde(default)]
    pub quantization: Option<String>,
    pub context_length: u32,
    #[serde(default)]
    pub ollama_version: Option<String>,
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

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct BenchmarkInput {
    pub device_profile_id: Option<String>,
    pub volume_id: Option<String>,
    pub model_name: String,
    pub model_digest: Option<String>,
    pub quantization: Option<String>,
    pub context_length: u32,
    pub ollama_version: Option<String>,
    pub storage_media_kind: String,
    pub cold_load_ms: Option<f64>,
    pub warm_load_ms: Option<f64>,
    pub ttft_median_ms: Option<f64>,
    pub tok_per_sec_median: Option<f64>,
    pub peak_ram_bytes: Option<u64>,
    pub repetitions: u32,
    pub raw_report_json: String,
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<BenchmarkReportRecord> {
    Ok(BenchmarkReportRecord {
        id: row.get(0)?,
        device_profile_id: row.get(1)?,
        volume_id: row.get(2)?,
        model_name: row.get(3)?,
        model_digest: row.get(4)?,
        quantization: row.get(5)?,
        context_length: row.get::<_, i64>(6)? as u32,
        ollama_version: row.get(7)?,
        storage_media_kind: row.get(8)?,
        cold_load_ms: row.get(9)?,
        warm_load_ms: row.get(10)?,
        ttft_median_ms: row.get(11)?,
        tok_per_sec_median: row.get(12)?,
        peak_ram_bytes: row.get::<_, Option<i64>>(13)?.map(|v| v as u64),
        repetitions: row.get::<_, i64>(14)? as u32,
        raw_report_json: row.get(15)?,
        created_at: row.get(16)?,
    })
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
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                id,
                input.device_profile_id,
                input.volume_id,
                input.model_name,
                input.model_digest,
                input.quantization,
                i64::from(input.context_length),
                input.ollama_version,
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
        device_profile_id: input.device_profile_id.clone(),
        volume_id: input.volume_id.clone(),
        model_name: input.model_name.clone(),
        model_digest: input.model_digest.clone(),
        quantization: input.quantization.clone(),
        context_length: input.context_length,
        ollama_version: input.ollama_version.clone(),
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
            "SELECT id, device_profile_id, volume_id, model_name, model_digest,
                    quantization, context_length, ollama_version, storage_media_kind,
                    cold_load_ms, warm_load_ms, ttft_median_ms, tok_per_sec_median,
                    peak_ram_bytes, repetitions, raw_report_json, created_at
             FROM benchmark_reports ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], row_to_record)?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

pub fn get_benchmark_report(
    store: &SettingsStore,
    id: &str,
) -> Result<Option<BenchmarkReportRecord>, StoreError> {
    store.with_conn(|conn| {
        conn.query_row(
            "SELECT id, device_profile_id, volume_id, model_name, model_digest,
                    quantization, context_length, ollama_version, storage_media_kind,
                    cold_load_ms, warm_load_ms, ttft_median_ms, tok_per_sec_median,
                    peak_ram_bytes, repetitions, raw_report_json, created_at
             FROM benchmark_reports WHERE id = ?1",
            params![id],
            row_to_record,
        )
        .optional()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::system_probe::SystemProfile;

    #[test]
    fn benchmark_report_roundtrip_with_fk_metadata() {
        let store = SettingsStore::open_in_memory().unwrap();
        let prof_id = store
            .record_device_profile(&SystemProfile {
                os_name: "Darwin".into(), os_version: "15".into(), architecture: "aarch64".into(),
                cpu_brand: "M3".into(), physical_cores: Some(8), logical_cores: 8,
                ram_total_bytes: 16_000_000_000, ram_available_bytes: 8_000_000_000,
                is_unified_memory: true, metal_wired_limit_bytes: None, gpus: vec![],
                gpu_status: "unified_memory".into(), detected_at: "2026-11-18T00:00:00Z".into(),
            })
            .unwrap();
        let saved = save_benchmark_report(
            &store,
            &BenchmarkInput {
                device_profile_id: Some(prof_id.clone()),
                volume_id: None,
                model_name: "llama3.2:3b".into(),
                model_digest: Some("sha256:abc".into()),
                quantization: Some("Q4_K_M".into()),
                context_length: 4096,
                ollama_version: Some("0.40.9".into()),
                storage_media_kind: "SSD".into(),
                cold_load_ms: Some(1200.0),
                warm_load_ms: Some(10.0),
                ttft_median_ms: Some(80.0),
                tok_per_sec_median: Some(42.0),
                peak_ram_bytes: Some(4_000_000_000),
                repetitions: 2,
                raw_report_json: "{}".into(),
            },
        )
        .unwrap();
        let fetched = get_benchmark_report(&store, &saved.id).unwrap().unwrap();
        assert_eq!(fetched.device_profile_id.as_deref(), Some(prof_id.as_str()));
        assert_eq!(fetched.quantization.as_deref(), Some("Q4_K_M"));
        assert_eq!(fetched.ollama_version.as_deref(), Some("0.40.9"));
    }
}
