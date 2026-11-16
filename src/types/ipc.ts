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

export interface SpikeReport {
  system: SystemProfile;
  external_volumes: ExternalVolume[];
  ollama: OllamaStatus;
  analytics: AnalyticsHealth;
}
