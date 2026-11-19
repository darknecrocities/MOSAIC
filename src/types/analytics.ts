export type ExecutionProfile =
  | 'auto_adaptive'
  | 'max_quality'
  | 'balanced'
  | 'constrained_memory';

export type KvCacheType = 'auto' | 'f16' | 'q8_0' | 'q4_0';

export interface ExecutionPlan {
  profile: string;
  kv_cache_type: string;
  num_ctx: number;
  num_gpu: number;
  num_batch: number;
  num_ubatch: number;
  num_thread: number;
  use_mmap: boolean;
  use_mlock: boolean;
  keep_alive: string;
  flash_attention: boolean;
  num_parallel: number;
  offload_ratio: number;
  warnings: string[];
}

export interface CatalogRefreshResult {
  count: number;
  source_url: string;
  refreshed_at: string;
}

export interface HardwareAnalysisReport {
  os?: Record<string, unknown>;
  cpu?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  ram_effective_avail_bytes: number;
  metal_wired_limit_bytes: number | null;
  gpu_devices: Array<Record<string, unknown>>;
  gpu?: Record<string, unknown>;
  limitations: string[];
  confidence?: string;
  source?: string;
}

export interface PerformanceAnalysisReport {
  bottlenecks: Array<Record<string, unknown>>;
  efficiency_ratios?: Record<string, unknown>;
  efficiency_ratio?: number;
  recommendations?: string[];
  suggestions?: string[];
  summary?: string;
  confidence?: string;
  limitations?: string[];
}

export interface ModelShowDetails {
  model: string;
  modelfile: string | null;
  parameters: string | null;
  template: string | null;
  license: string | null;
  native_context_length?: number | null;
  details: {
    format: string | null;
    family: string | null;
    families: string[] | null;
    parameter_size: string | null;
    quantization_level: string | null;
  } | null;
  model_info: Record<string, unknown> | null;
  capabilities: string[] | null;
}

export interface DiagnosticEntry {
  id: string | number;
  severity: string;
  component: string;
  message: string;
  created_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatStreamRequest {
  session_id: string;
  model: string;
  messages: ChatMessage[];
  num_ctx?: number | null;
  temperature?: number | null;
  execution_profile?: string | null;
  kv_cache_type?: string | null;
  num_gpu?: number | null;
  num_batch?: number | null;
  num_ubatch?: number | null;
  num_thread?: number | null;
  use_mmap?: boolean | null;
  use_mlock?: boolean | null;
  keep_alive?: string | null;
}

export interface ExportedReport {
  format: string;
  content: string;
}

export interface MigrationResult {
  files_copied: number;
  bytes_copied: number;
}

export interface ClusterWorker {
  id: string;
  name: string;
  host: string;
  port: number;
  vram_bytes: number;
  ram_available_bytes: number;
  backend: string;
  status: string;
  rtt_ms: number | null;
  created_at: string;
}

export interface NodeAllocation {
  name: string;
  role: string;
  endpoint: string;
  allocated_bytes: number;
  budget_bytes: number;
}

export interface ClusterPlan {
  strategy: string;
  feasible: boolean;
  is_moe: boolean;
  total_demand_bytes: number;
  tier1_gpu_bytes: number;
  tier2_ram_bytes: number;
  tier3_disk_mmap_bytes: number;
  node_allocations: NodeAllocation[];
  runtime_flags: string[];
  warnings: string[];
}

export interface BenchmarkReportRecord {
  id: string;
  model_name: string;
  context_length: number;
  storage_media_kind: string;
  cold_load_ms: number | null;
  warm_load_ms: number | null;
  ttft_median_ms: number | null;
  tok_per_sec_median: number | null;
  peak_ram_bytes: number | null;
  repetitions: number;
  raw_report_json: string;
  created_at: string;
  device_profile_id?: string | null;
  volume_id?: string | null;
  model_digest?: string | null;
  quantization?: string | null;
  ollama_version?: string | null;
}
