use std::sync::atomic::{AtomicUsize, Ordering};

use crate::core::cluster_manager::ClusterRuntimeRegistry;
use crate::core::download_manager::DownloadRegistry;
use crate::core::inference_manager::{ChatStreamRequest, InferenceRegistry};
use crate::core::migration;
use crate::core::settings_store::AppSettingsSnapshot;
use crate::core::system_probe;

#[derive(Default)]
pub struct RuntimeState {
    pub downloads: DownloadRegistry,
    pub inference: InferenceRegistry,
    pub active_benchmarks: AtomicUsize,
}

pub struct ActiveOpGuard<'a>(&'a AtomicUsize);

impl<'a> ActiveOpGuard<'a> {
    pub fn acquire(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for ActiveOpGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl RuntimeState {
    pub fn begin_benchmark(&self) -> ActiveOpGuard<'_> {
        ActiveOpGuard::acquire(&self.active_benchmarks)
    }

    pub fn has_active_operations(&self, cluster_rt: &ClusterRuntimeRegistry) -> bool {
        self.downloads.has_active()
            || self.inference.is_running()
            || self.active_benchmarks.load(Ordering::SeqCst) > 0
            || migration::is_migration_active()
            || cluster_rt.is_running()
    }
}

fn default_batches(profile: &str, ram_total: u64) -> (u32, u32) {
    match profile {
        "max_quality" => (512, 512),
        "constrained_memory" => (128, 64),
        "balanced" => (256, 128),
        _ => {
            if ram_total >= 24 * 1024_u64.pow(3) {
                (512, 512)
            } else {
                (256, 128)
            }
        }
    }
}

pub fn apply_adaptive_chat_defaults(
    mut req: ChatStreamRequest,
    settings: &AppSettingsSnapshot,
    system: &system_probe::SystemProfile,
) -> ChatStreamRequest {
    let profile = req
        .execution_profile
        .as_deref()
        .unwrap_or(&settings.execution_profile)
        .to_string();
    let (def_b, def_ub) = default_batches(&profile, system.ram_total_bytes);
    if req.num_ctx.is_none() {
        req.num_ctx = Some(settings.default_context_length);
    }
    if req.num_thread.is_none() {
        req.num_thread = settings
            .num_thread
            .or_else(|| system.physical_cores.map(|c| c as u32));
    }
    if req.num_batch.is_none() {
        req.num_batch = settings.num_batch.or(Some(def_b));
    }
    if req.num_ubatch.is_none() {
        req.num_ubatch = settings.num_ubatch.or(Some(def_ub));
    }
    if req.use_mmap.is_none() {
        req.use_mmap = Some(true);
    }
    if req.use_mlock.is_none() {
        req.use_mlock = Some(false);
    }
    if req.keep_alive.is_none() {
        let ka = if profile == "constrained_memory" {
            "30s".to_string()
        } else {
            settings.keep_alive.clone()
        };
        req.keep_alive = Some(ka);
    }
    req
}
