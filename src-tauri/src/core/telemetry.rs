use serde::Serialize;
use sysinfo::System;

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
