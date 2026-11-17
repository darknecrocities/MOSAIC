export interface GpuDeviceInfo {
  vendor: string;
  model: string;
  vram_bytes: number | null;
  unified_memory: boolean;
  source: string;
}

export interface SystemProfile {
  os_name: string;
  os_version: string;
  architecture: string;
  cpu_brand: string;
  physical_cores: number | null;
  logical_cores: number;
  ram_total_bytes: number;
  ram_available_bytes: number;
  is_unified_memory: boolean;
  gpus: GpuDeviceInfo[];
  gpu_status: string;
  detected_at: string;
}

export interface ResourceTelemetry {
  cpu_usage_percent: number;
  ram_total_bytes: number;
  ram_available_bytes: number;
  ram_used_bytes: number;
  sampled_at: string;
}

export interface ExternalVolume {
  volume_identifier: string;
  label: string;
  mount_path: string;
  filesystem: string;
  protocol: string;
  media_kind: string;
  total_bytes: number;
  free_bytes: number;
  writable: boolean;
  advisory: string | null;
}

export interface ActiveLibraryRecord {
  volume_identifier: string;
  label: string;
  mount_path: string;
  filesystem: string;
  media_kind: string;
  directory_path: string;
  ollama_configured: boolean;
  free_bytes: number;
  total_bytes: number;
  verified_at: string;
}

export interface OllamaStatus {
  installed: boolean;
  binary_path: string | null;
  app_bundle_present: boolean;
  cli_version: string | null;
  api_reachable: boolean;
  api_version: string | null;
  endpoint: string;
  env_ollama_models: string | null;
  launchd_ollama_models: string | null;
  runtime_mode: string;
}

export interface AnalyticsHealth {
  available: boolean;
  python_path: string | null;
  protocol_version: string | null;
  service_version: string | null;
  error: string | null;
}

export interface AppSettingsSnapshot {
  safety_reserve_gib: number;
  ollama_endpoint: string;
  telemetry_poll_ms: number;
  ollama_management_mode: string;
}

export interface AppBootstrapState {
  system: SystemProfile;
  telemetry: ResourceTelemetry;
  external_volumes: ExternalVolume[];
  active_library: ActiveLibraryRecord | null;
  library_connected: boolean;
  ollama: OllamaStatus;
  analytics: AnalyticsHealth;
  settings: AppSettingsSnapshot;
}

export type NavRoute =
  | 'overview'
  | 'discover'
  | 'my-models'
  | 'run'
  | 'hardware'
  | 'storage'
  | 'settings';

export type FitStatus = 'Recommended' | 'Borderline' | 'Not recommended' | 'Unknown';

export interface CatalogModelEntry {
  ollama_name: string;
  display_name: string;
  provider: string;
  parameter_billions: number;
  quantization: string;
  download_size_bytes: number;
  n_layers: number;
  n_kv_heads: number;
  head_dim: number;
  default_context: number;
  license_name: string;
  license_url: string;
  summary: string;
}

export interface ModelFitAssessment {
  fit_status: FitStatus;
  weight_memory_estimate: number | null;
  runtime_overhead_estimate: number | null;
  kv_cache_estimate: number | null;
  total_estimated_bytes: number | null;
  available_budget: number | null;
  context_length: number;
  expected_backend: string;
  performance_estimate: string;
  reasons: string[];
  source: string;
  confidence: string;
}

export interface CatalogModelWithFit {
  model: CatalogModelEntry;
  fit: ModelFitAssessment;
}
