import type {
  ActiveLibraryRecord,
  AppBootstrapState,
  AppSettingsSnapshot,
  BenchmarkReportRecord,
  CatalogModelWithFit,
  CatalogRefreshResult,
  ChatStreamRequest,
  ClusterPlan,
  ClusterWorker,
  DiagnosticEntry,
  ExportedReport,
  HardwareAnalysisReport,
  InstalledModel,
  MigrationPreview,
  MigrationResult,
  ModelShowDetails,
  OllamaStatus,
  PerformanceAnalysisReport,
  ResourceTelemetry,
} from '../types/ipc';
import { invokeCommand } from './tauriClient';

export const mosaicApi = {
  getAppState: () => invokeCommand<AppBootstrapState>('get_app_state'),
  getTelemetry: () => invokeCommand<ResourceTelemetry>('get_telemetry'),
  selectExternalLibrary: (volumeIdentifier: string) =>
    invokeCommand<ActiveLibraryRecord>('select_external_library', { volumeIdentifier }),
  updateSetting: (key: string, value: unknown) =>
    invokeCommand<AppSettingsSnapshot>('update_setting', { key, value }),
  getDiagnostics: (limit = 50) =>
    invokeCommand<DiagnosticEntry[]>('get_diagnostics', { limit }),
  listCatalogWithFit: (
    contextLength: number,
    executionProfile: string,
    kvCacheType: string
  ) =>
    invokeCommand<CatalogModelWithFit[]>('list_catalog_with_fit', {
      contextLength,
      executionProfile,
      kvCacheType: kvCacheType === 'auto' ? null : kvCacheType,
    }),
  refreshModelCatalog: (url?: string | null) =>
    invokeCommand<CatalogRefreshResult>('refresh_model_catalog', { url: url ?? null }),
  analyzeHardwareInsights: () =>
    invokeCommand<HardwareAnalysisReport>('analyze_hardware_insights'),
  pullModel: (model: string, estimatedBytes: number | null) =>
    invokeCommand<void>('pull_model', { model, estimatedBytes }),
  cancelPull: (model: string) => invokeCommand<boolean>('cancel_pull', { model }),
  listInstalledModels: () => invokeCommand<InstalledModel[]>('list_installed_models'),
  showModelDetails: (model: string) =>
    invokeCommand<ModelShowDetails>('show_model_details', { model }),
  deleteInstalledModel: (model: string, confirmed: boolean) =>
    invokeCommand<void>('delete_installed_model', { model, confirmed }),
  startChatStream: (request: ChatStreamRequest) =>
    invokeCommand<void>('start_chat_stream', { request }),
  stopChatStream: () => invokeCommand<boolean>('stop_chat_stream'),
  unloadModel: (model: string) => invokeCommand<void>('unload_model', { model }),
  configureOllamaStorage: (confirmed: boolean) =>
    invokeCommand<string>('configure_ollama_storage', { confirmed }),
  startManagedOllama: (confirmed: boolean) =>
    invokeCommand<OllamaStatus>('start_managed_ollama', { confirmed }),
  stopManagedOllama: (confirmed: boolean) =>
    invokeCommand<OllamaStatus>('stop_managed_ollama', { confirmed }),
  prepareSafeEject: () => invokeCommand<string>('prepare_safe_eject'),
  previewInternalMigration: () =>
    invokeCommand<MigrationPreview>('preview_internal_migration'),
  executeInternalMigration: (confirmed: boolean) =>
    invokeCommand<MigrationResult>('execute_internal_migration', { confirmed }),
  listClusterWorkers: () => invokeCommand<ClusterWorker[]>('list_cluster_workers'),
  addClusterWorker: (request: {
    name: string;
    host: string;
    port: number;
    vram_gib: number;
    ram_gib: number;
    backend: string;
    allow_lan: boolean;
  }) => invokeCommand<ClusterWorker>('add_cluster_worker', { request }),
  removeClusterWorker: (id: string) =>
    invokeCommand<void>('remove_cluster_worker', { id }),
  probeClusterWorkers: () => invokeCommand<ClusterWorker[]>('probe_cluster_workers'),
  planAdaptiveExecution: (ollamaName: string, contextLength: number) =>
    invokeCommand<ClusterPlan>('plan_adaptive_execution', { ollamaName, contextLength }),
  launchClusterRuntime: (
    ggufRelPath: string,
    runtimeFlags: string[],
    confirmed: boolean
  ) =>
    invokeCommand<string>('launch_cluster_runtime', {
      ggufRelPath,
      runtimeFlags,
      confirmed,
    }),
  stopClusterRuntime: () => invokeCommand<boolean>('stop_cluster_runtime'),
  runModelBenchmark: (params: {
    model: string;
    contextLength: number;
    repetitions: number;
    executionProfile?: string | null;
    kvCacheType?: string | null;
  }) =>
    invokeCommand<BenchmarkReportRecord>('run_model_benchmark', {
      model: params.model,
      contextLength: params.contextLength,
      repetitions: params.repetitions,
      executionProfile: params.executionProfile ?? null,
      kvCacheType: params.kvCacheType === 'auto' ? null : (params.kvCacheType ?? null),
    }),
  listBenchmarkReports: (limit = 20) =>
    invokeCommand<BenchmarkReportRecord[]>('list_benchmark_reports', { limit }),
  analyzeBenchmarkPerformance: (reportId: string) =>
    invokeCommand<PerformanceAnalysisReport>('analyze_benchmark_performance', { reportId }),
  exportBenchmarkReport: (reportId: string, format: 'json' | 'csv' | 'html') =>
    invokeCommand<ExportedReport>('export_benchmark_report', { reportId, format }),
};
