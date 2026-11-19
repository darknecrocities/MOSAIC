import type {
  ActiveLibraryRecord,
  AppBootstrapState,
  AppSettingsSnapshot,
  BenchmarkReportRecord,
  CatalogModelEntry,
  ClusterWorker,
  ExternalVolume,
  InstalledModel,
  MigrationPreview,
  OllamaStatus,
  SystemProfile,
} from '../../../src/types/ipc';

export type FixtureProfileId =
  | 'disconnected'
  | 'connected-16gb-m3'
  | 'connected-8gb-constrained'
  | 'readonly-drive'
  | 'low-space-drive'
  | 'cluster-3node'
  | 'active-pull-stream'
  | 'degraded-python-ollama-stopped';

export type ExecutionProfile = 'auto_adaptive' | 'max_quality' | 'balanced' | 'constrained_memory';
export type KvCacheType = 'f16' | 'q8_0' | 'q4_0';

export interface DiagnosticEntry {
  id: number;
  severity: 'info' | 'warn' | 'error';
  component: string;
  message: string;
  created_at: string;
}

export interface MutableFixtureState {
  profile: FixtureProfileId;
  bootstrap: AppBootstrapState;
  installed: InstalledModel[];
  reports: BenchmarkReportRecord[];
  workers: ClusterWorker[];
  diagnostics: DiagnosticEntry[];
  catalogEntries: Array<Partial<CatalogModelEntry> & { ollama_name: string; display_name: string }>;
  migrationPreview: MigrationPreview;
  activePulls: Record<string, { completed: number; total: number; cancelled: boolean }>;
  activeInferenceSession: string | null;
  clusterRuntimeRunning: boolean;
  catalogRefreshFails: boolean;
  exportReportFails: boolean;
  streamHttpError: string | null;
  showFailModel: string | null;
  executionProfile: ExecutionProfile;
  kvCacheType: KvCacheType;
  nextDiagId: number;
}

const GIB = 1024 ** 3;
const NOW = '2026-11-18T13:00:00Z';

export const ONE_TOUCH_VOLUME: ExternalVolume = {
  volume_identifier: '95AE3673-713F-3C93-AAB0-FCBB496C45CD',
  label: 'One Touch',
  mount_path: '/Volumes/One Touch',
  filesystem: 'ExFAT',
  protocol: 'USB',
  media_kind: 'unknown',
  total_bytes: 1_000_000_000_000,
  free_bytes: 615_000_000_000,
  writable: true,
  advisory: 'ExFAT external drive detected; verify sequential load latency via benchmark.',
};

export const MOSAIC_NVME_VOLUME: ExternalVolume = {
  volume_identifier: 'EXT-8GB-SSD-01', label: 'MosaicNVMe', mount_path: '/Volumes/MosaicNVMe',
  filesystem: 'APFS', protocol: 'Thunderbolt', media_kind: 'SSD',
  total_bytes: 512_000_000_000, free_bytes: 240_000_000_000, writable: true, advisory: null,
};

export const READONLY_NTFS_VOLUME: ExternalVolume = {
  volume_identifier: 'RO-NTFS-01', label: 'ReadOnlyNTFS', mount_path: '/Volumes/ReadOnlyNTFS',
  filesystem: 'NTFS', protocol: 'USB', media_kind: 'HDD',
  total_bytes: 1_000_000_000_000, free_bytes: 500_000_000_000, writable: false,
  advisory: 'Volume is mounted read-only and cannot store models.',
};

export const MOSAIC_SSD_VOLUME: ExternalVolume = {
  volume_identifier: 'SSD-WRITABLE-02', label: 'MosaicSSD', mount_path: '/Volumes/MosaicSSD',
  filesystem: 'APFS', protocol: 'USB-C', media_kind: 'SSD',
  total_bytes: 500_000_000_000, free_bytes: 400_000_000_000, writable: true, advisory: null,
};

export const TINY_USB_VOLUME: ExternalVolume = {
  volume_identifier: 'LOW-SPACE-01', label: 'TinyUSB', mount_path: '/Volumes/TinyUSB',
  filesystem: 'ExFAT', protocol: 'USB', media_kind: 'SSD',
  total_bytes: 32_000_000_000, free_bytes: 1_500_000_000, writable: true,
  advisory: 'Low remaining external storage capacity.',
};

const M3_SYSTEM: SystemProfile = {
  os_name: 'macOS', os_version: '15.1', architecture: 'aarch64', cpu_brand: 'Apple M3',
  physical_cores: 8, logical_cores: 8, ram_total_bytes: 16 * GIB, ram_available_bytes: 10 * GIB,
  is_unified_memory: true,
  gpus: [{ vendor: 'Apple', model: 'Apple M3 GPU', vram_bytes: null, unified_memory: true, source: 'measured' }],
  gpu_status: 'unified_memory', detected_at: NOW,
};

const CONSTRAINED_8GB_SYSTEM: SystemProfile = {
  os_name: 'Linux', os_version: '6.8', architecture: 'x86_64', cpu_brand: 'Intel Core i5-1240P',
  physical_cores: 12, logical_cores: 16, ram_total_bytes: 8 * GIB, ram_available_bytes: Math.round(4.5 * GIB),
  is_unified_memory: false,
  gpus: [{ vendor: 'nvidia', model: 'RTX 3050 Laptop', vram_bytes: 4 * GIB, unified_memory: false, source: 'measured' }],
  gpu_status: 'discrete_gpu', detected_at: NOW,
};

const DEGRADED_LINUX_SYSTEM: SystemProfile = {
  os_name: 'Linux', os_version: '6.8', architecture: 'x86_64', cpu_brand: 'AMD Ryzen 5 5600',
  physical_cores: 6, logical_cores: 12, ram_total_bytes: 16 * GIB, ram_available_bytes: 9 * GIB,
  is_unified_memory: false, gpus: [], gpu_status: 'unknown', detected_at: NOW,
};

const cat = (
  ollama_name: string, display_name: string, provider: string, parameter_billions: number,
  quantization: string, download_size_bytes: number, n_layers: number, n_kv_heads: number,
  head_dim: number, default_context: number, license_name: string, license_url: string,
  summary: string, active_parameter_billions?: number
): CatalogModelEntry => ({
  ollama_name, display_name, provider, parameter_billions, quantization, download_size_bytes,
  n_layers, n_kv_heads, head_dim, default_context, license_name, license_url, summary,
  ...(active_parameter_billions ? { is_moe: true, active_parameter_billions } : {}),
});

const CATALOG_PRESETS: CatalogModelEntry[] = [
  cat('qwen2.5:0.5b', 'Qwen 2.5 0.5B', 'Alibaba', 0.5, 'Q4_K_M', 397_000_000, 24, 2, 64, 4096, 'Apache-2.0', 'https://ollama.com/library/qwen2.5', 'Ultra-lightweight model for low-memory laptops.'),
  cat('llama3.2:1b', 'Llama 3.2 1B', 'Meta', 1.24, 'Q8_0', 1_320_000_000, 16, 8, 64, 4096, 'Llama 3.2 Community', 'https://ollama.com/library/llama3.2', 'Compact multilingual instruction model.'),
  cat('llama3.2:3b', 'Llama 3.2 3B', 'Meta', 3.21, 'Q4_K_M', 2_020_000_000, 28, 8, 128, 4096, 'Llama 3.2 Community', 'https://ollama.com/library/llama3.2', 'Balanced 3B instruction model.'),
  cat('mistral:7b-instruct-q4_K_M', 'Mistral 7B Instruct', 'Mistral AI', 7.25, 'Q4_K_M', 4_370_000_000, 32, 8, 128, 4096, 'Apache-2.0', 'https://ollama.com/library/mistral', 'Classic 7B instruction model with GQA.'),
  cat('hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS', 'Qwen3 30B-A3B MoE (IQ2_XS)', 'Alibaba / Bartowski', 30.5, 'IQ2_XS', 9_140_316_832, 48, 4, 128, 8192, 'Apache-2.0', 'https://huggingface.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF', '30B sparse MoE (3.3B active) quantized to IQ2_XS for 16 GiB systems.', 3.3),
  cat('hf.co/unsloth/Qwen3-30B-A3B-GGUF:IQ3_XXS', 'Qwen3 30B-A3B MoE (IQ3_XXS)', 'Alibaba / Unsloth', 30.5, 'IQ3_XXS', 12_100_000_000, 48, 4, 128, 8192, 'Apache-2.0', 'https://huggingface.co/unsloth/Qwen3-30B-A3B-GGUF', '30B sparse MoE in IQ3_XXS requiring constrained KV precision on 16 GiB hosts.', 3.3),
  cat('qwen3:30b-a3b', 'Qwen 3 30B-A3B MoE', 'Alibaba', 30.5, 'Q4_K_M', 18_500_000_000, 48, 4, 128, 8192, 'Apache-2.0', 'https://ollama.com/library/qwen3', 'Sparse 30B MoE (3.3B active) at Q4_K_M.', 3.3),
  cat('deepseek-r1:70b-llama-distill-q4_K_M', 'DeepSeek-R1 Distill 70B', 'DeepSeek', 70.6, 'Q4_K_M', 42_520_000_000, 80, 8, 128, 4096, 'MIT', 'https://ollama.com/library/deepseek-r1', 'Large 70B reasoning model suited for workstation or RPC pooling.'),
  cat('qwen3:235b-a22b-q4_K_M', 'Qwen 3 235B-A22B MoE', 'Alibaba', 235.0, 'Q4_K_M', 134_000_000_000, 94, 4, 128, 4096, 'Apache-2.0', 'https://ollama.com/library/qwen3', '235B sparse MoE requiring multi-node GGML_RPC pooling.', 22.0),
];

function toActiveLib(vol: ExternalVolume, configured: boolean): ActiveLibraryRecord {
  return {
    volume_identifier: vol.volume_identifier, label: vol.label, mount_path: vol.mount_path,
    filesystem: vol.filesystem, media_kind: vol.media_kind,
    directory_path: `${vol.mount_path}/MOSAIC/ollama-models`,
    ollama_configured: configured, free_bytes: vol.free_bytes, total_bytes: vol.total_bytes, verified_at: NOW,
  };
}

function makeOllama(reachable: boolean, envModels: string | null): OllamaStatus {
  return {
    installed: true, binary_path: '/opt/homebrew/bin/ollama', app_bundle_present: true,
    cli_version: '0.40.9', api_reachable: reachable, api_version: reachable ? '0.40.9' : null,
    endpoint: 'http://127.0.0.1:11434', env_ollama_models: envModels,
    launchd_ollama_models: envModels, runtime_mode: reachable ? 'cli_service' : 'stopped',
  };
}

const DEFAULT_SETTINGS: AppSettingsSnapshot = {
  safety_reserve_gib: 3.0, ollama_endpoint: 'http://127.0.0.1:11434',
  telemetry_poll_ms: 5000, ollama_management_mode: 'managed_or_detected',
  default_context_length: 4096, execution_profile: 'auto_adaptive',
  kv_cache_type: 'auto', max_loaded_models: 1,
  num_thread: null, num_batch: null, num_ubatch: null,
  keep_alive: '5m', num_parallel: 1,
};

const SEED_REPORT: BenchmarkReportRecord = {
  id: 'rep-seed-001', model_name: 'llama3.2:3b', context_length: 4096, storage_media_kind: 'unknown',
  cold_load_ms: 2150, warm_load_ms: 190, ttft_median_ms: 145, tok_per_sec_median: 42.6,
  peak_ram_bytes: Math.round(3.1 * GIB), repetitions: 2, raw_report_json: '{"model":"llama3.2:3b"}', created_at: NOW,
};

const mkModel = (name: string, size_bytes: number, digest: string, family: string, parameter_size: string, quantization_level: string): InstalledModel =>
  ({ name, size_bytes, digest, modified_at: NOW, family, parameter_size, quantization_level });

export function createFixtureState(profile: FixtureProfileId): MutableFixtureState {
  let system = { ...M3_SYSTEM };
  let volumes: ExternalVolume[] = [];
  let activeLib: ActiveLibraryRecord | null = null;
  let connected = false;
  let ollama = makeOllama(true, null);
  let analytics: AppBootstrapState['analytics'] = { available: true, python_path: '/opt/mosaic/venv/bin/python', protocol_version: '1.0', service_version: '1.0.0', error: null };
  let installed: InstalledModel[] = [];
  let reports: BenchmarkReportRecord[] = [];
  let workers: ClusterWorker[] = [];
  let activePulls: MutableFixtureState['activePulls'] = {};
  let migrationPreview: MigrationPreview = { source_dir: '/Users/mosaic/.ollama/models', exists: false, blob_count: 0, manifest_count: 0, total_bytes: 0, fits_on_external: false };

  if (profile === 'connected-16gb-m3') {
    volumes = [{ ...ONE_TOUCH_VOLUME }];
    activeLib = toActiveLib(ONE_TOUCH_VOLUME, true);
    connected = true;
    ollama = makeOllama(true, activeLib.directory_path);
    installed = [
      mkModel('llama3.2:3b', 2_020_000_000, 'sha256:a1b2c3d4e5f6', 'llama', '3.2B', 'Q4_K_M'),
      mkModel('mistral:7b-instruct-q4_K_M', 4_370_000_000, 'sha256:f6e5d4c3b2a1', 'llama', '7.2B', 'Q4_K_M'),
      mkModel('hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS', 9_140_316_832, 'sha256:998877665544', 'qwen3moe', '30.5B', 'IQ2_XS'),
    ];
    reports = [{ ...SEED_REPORT }];
  } else if (profile === 'connected-8gb-constrained') {
    system = { ...CONSTRAINED_8GB_SYSTEM };
    volumes = [{ ...MOSAIC_NVME_VOLUME }];
    activeLib = toActiveLib(MOSAIC_NVME_VOLUME, true);
    connected = true;
    ollama = makeOllama(true, activeLib.directory_path);
    installed = [
      mkModel('qwen2.5:0.5b', 397_000_000, 'sha256:112233445566', 'qwen2', '0.5B', 'Q4_K_M'),
      mkModel('llama3.2:1b', 1_320_000_000, 'sha256:665544332211', 'llama', '1.2B', 'Q8_0'),
    ];
  } else if (profile === 'readonly-drive') {
    volumes = [{ ...READONLY_NTFS_VOLUME }, { ...MOSAIC_SSD_VOLUME }];
  } else if (profile === 'low-space-drive') {
    volumes = [{ ...TINY_USB_VOLUME }];
    activeLib = toActiveLib(TINY_USB_VOLUME, true);
    connected = true;
    ollama = makeOllama(true, activeLib.directory_path);
    installed = [mkModel('qwen2.5:0.5b', 397_000_000, 'sha256:112233445566', 'qwen2', '0.5B', 'Q4_K_M')];
    migrationPreview = { source_dir: '/Users/mosaic/.ollama/models', exists: true, blob_count: 4, manifest_count: 2, total_bytes: 3_200_000_000, fits_on_external: false };
  } else if (profile === 'cluster-3node') {
    volumes = [{ ...ONE_TOUCH_VOLUME }];
    activeLib = toActiveLib(ONE_TOUCH_VOLUME, true);
    connected = true;
    ollama = makeOllama(true, activeLib.directory_path);
    installed = [mkModel('hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS', 9_140_316_832, 'sha256:998877665544', 'qwen3moe', '30.5B', 'IQ2_XS')];
    workers = [
      { id: 'wrk-1', name: 'RTX-Node-A', host: '192.168.1.50', port: 50052, vram_bytes: 24 * GIB, ram_available_bytes: 32 * GIB, backend: 'ggml_rpc', status: 'reachable', rtt_ms: 2, created_at: NOW },
      { id: 'wrk-2', name: 'ROCm-Node-B', host: '192.168.1.51', port: 50052, vram_bytes: 16 * GIB, ram_available_bytes: 32 * GIB, backend: 'ggml_rpc', status: 'reachable', rtt_ms: 3, created_at: NOW },
    ];
  } else if (profile === 'active-pull-stream') {
    volumes = [{ ...ONE_TOUCH_VOLUME }];
    activeLib = toActiveLib(ONE_TOUCH_VOLUME, true);
    connected = true;
    ollama = makeOllama(true, activeLib.directory_path);
    activePulls = { 'llama3.2:3b': { completed: 512_000_000, total: 2_020_000_000, cancelled: false } };
  } else if (profile === 'degraded-python-ollama-stopped') {
    system = { ...DEGRADED_LINUX_SYSTEM };
    volumes = [{ ...ONE_TOUCH_VOLUME }];
    activeLib = toActiveLib(ONE_TOUCH_VOLUME, false);
    connected = true;
    ollama = makeOllama(false, null);
    analytics = { available: false, python_path: null, protocol_version: null, service_version: null, error: 'Python analytics worker exited' };
    migrationPreview = { source_dir: '/Users/mosaic/.ollama/models', exists: true, blob_count: 4, manifest_count: 2, total_bytes: 3_200_000_000, fits_on_external: true };
  }

  return {
    profile,
    bootstrap: {
      system,
      telemetry: { cpu_usage_percent: 18.4, ram_total_bytes: system.ram_total_bytes, ram_available_bytes: system.ram_available_bytes, ram_used_bytes: system.ram_total_bytes - system.ram_available_bytes, sampled_at: NOW },
      external_volumes: volumes, active_library: activeLib, library_connected: connected, ollama, analytics,
      settings: { ...DEFAULT_SETTINGS },
    },
    installed, reports, workers,
    diagnostics: [{ id: 1, severity: 'info', component: 'volume_manager', message: `Initialized profile ${profile}`, created_at: NOW }],
    catalogEntries: CATALOG_PRESETS.map((c) => ({ ...c })),
    migrationPreview, activePulls, activeInferenceSession: null, clusterRuntimeRunning: false,
    catalogRefreshFails: false, exportReportFails: false, streamHttpError: null, showFailModel: null,
    executionProfile: 'auto_adaptive', kvCacheType: 'q8_0', nextDiagId: 2,
  };
}
