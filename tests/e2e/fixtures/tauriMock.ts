import type { Page } from '@playwright/test';
import { createFixtureState, type FixtureProfileId, type MutableFixtureState } from './mockPayloads';

export interface MosaicE2EControl {
  profile: FixtureProfileId;
  invokeLog: Array<{ cmd: string; args: unknown; ts: number }>;
  emittedEvents: Array<{ event: string; payload: unknown; ts: number }>;
  state: MutableFixtureState;
  emitBackendEvent: (event: string, payload: unknown) => void;
  hasEventListener: (event: string) => boolean;
  setVolumes: (volumes: MutableFixtureState['bootstrap']['external_volumes']) => void;
  setFreeBytes: (volumeId: string, freeBytes: number) => void;
  setOllamaReachable: (reachable: boolean, version?: string | null) => void;
}

declare global {
  interface Window {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: Record<string, unknown>;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>;
    __MOSAIC_E2E__?: MosaicE2EControl;
  }
}
function initTauriRuntime(initialState: MutableFixtureState): void {
  const GIB = 1024 ** 3, state: MutableFixtureState = structuredClone(initialState);
  let nextId = 1, activeChatSeq = 0;
  const callbacks = new Map<number, { fn: (data: unknown) => void; once: boolean }>(), eventListeners = new Map<string, number[]>();
  const invokeLog: MosaicE2EControl['invokeLog'] = [], emittedEvents: MosaicE2EControl['emittedEvents'] = [];
  const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}(:[a-zA-Z0-9._-]{1,64})?$/;
  const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/;
  const FLAGS = new Set(['-ngl', '-c', '--ctx-size', '-ot', '--rpc', '-fa', '--flash-attn', '-ctk', '-ctv', '-t', '--threads', '-b', '--batch-size', '-ub', '--ubatch-size', '--mmap', '--mlock']);
  const SETTINGS = new Set(['safety_reserve_gib', 'ollama_endpoint', 'telemetry_poll_ms', 'ollama_management_mode', 'default_context_length', 'execution_profile', 'kv_cache_type', 'max_loaded_models', 'num_thread', 'num_batch', 'num_ubatch', 'keep_alive', 'num_parallel']);

  const unregisterCallback = (id: number): void => { callbacks.delete(id); };
  const runCallback = (id: number, data: unknown): void => {
    const entry = callbacks.get(id);
    if (!entry) return;
    if (entry.once) callbacks.delete(id);
    entry.fn(data);
  };
  const emitBackendEvent = (event: string, payload: unknown): void => {
    emittedEvents.push({ event, payload, ts: Date.now() });
    for (const handlerId of [...(eventListeners.get(event) ?? [])]) {
      runCallback(handlerId, { event, id: handlerId, payload });
    }
  };
  const unlistenEvent = (event: string, eventId: number): void => {
    const ids = eventListeners.get(event);
    if (ids) eventListeners.set(event, ids.filter((id) => id !== eventId));
    unregisterCallback(eventId);
  };
  const validateModel = (name: string): void => {
    if (!name || name.includes('..') || name.startsWith('-') || !MODEL_RE.test(name)) {
      throw new Error(`security validation failed: invalid model identifier: ${name}`);
    }
  };
  const pushDiag = (severity: 'info' | 'warn' | 'error', component: string, message: string): void => {
    state.diagnostics.unshift({ id: state.nextDiagId++, severity, component, message, created_at: new Date().toISOString() });
  };
  const syncActiveLibrary = (): void => {
    const lib = state.bootstrap.active_library;
    if (!lib) { state.bootstrap.library_connected = false; return; }
    const match = state.bootstrap.external_volumes.find((v) => v.volume_identifier === lib.volume_identifier);
    if (!match || !match.writable) { state.bootstrap.library_connected = false; return; }
    lib.free_bytes = match.free_bytes;
    lib.total_bytes = match.total_bytes;
    state.bootstrap.library_connected = true;
  };
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const evaluateCatalog = (args: Record<string, unknown>) => {
    const ctx = Number(args.contextLength ?? args.context_length ?? 4096);
    const reserve = Number(args.safetyReserveGib ?? args.safety_reserve_gib ?? state.bootstrap.settings.safety_reserve_gib);
    const execProfile = String(args.executionProfile ?? args.execution_profile ?? state.executionProfile) as MutableFixtureState['executionProfile'];
    const kvType = String(args.kvCacheType ?? args.kv_cache_type ?? (execProfile === 'constrained_memory' ? 'q4_0' : state.kvCacheType)) as MutableFixtureState['kvCacheType'];
    const kvMult = kvType === 'q4_0' ? 0.25 : kvType === 'q8_0' ? 0.5 : 1.0;
    const effCtx = execProfile === 'constrained_memory' ? Math.min(ctx, 8192) : ctx;
    const availRam = Math.max(0, state.bootstrap.system.ram_available_bytes - reserve * GIB);
    const discreteVram = state.bootstrap.system.is_unified_memory ? 0 : state.bootstrap.system.gpus.reduce((s, g) => s + (g.vram_bytes ?? 0), 0);
    const budget = availRam + discreteVram;
    const source = state.bootstrap.analytics.available ? 'python' : 'rust_fallback';
    return state.catalogEntries.map((entry) => {
      if (entry.n_layers == null || entry.download_size_bytes == null || entry.parameter_billions == null) {
        return { model: entry, fit: { fit_status: 'Unknown', weight_memory_estimate: null, runtime_overhead_estimate: null, kv_cache_estimate: null, total_estimated_bytes: null, available_budget: budget, context_length: effCtx, expected_backend: 'unknown', performance_estimate: 'Not benchmarked yet', reasons: ['Insufficient model weight or parameter metadata.'], source, confidence: 'low', execution_plan: null } };
      }
      const weight = Math.round(entry.download_size_bytes * 1.05);
      const kv = Math.round(2 * entry.n_layers * (entry.n_kv_heads ?? 8) * (entry.head_dim ?? 128) * 2 * effCtx * kvMult);
      const overhead = Math.round(0.5 * GIB);
      const total = weight + kv + overhead;
      const isIqMoe = Boolean(entry.is_moe && String(entry.quantization).startsWith('IQ'));
      const fitStatus = total <= budget * 0.85 ? 'Recommended' : (total <= budget * 1.2 || (isIqMoe && total <= budget * 1.5)) ? 'Borderline' : 'Not recommended';
      const gpuBudget = state.bootstrap.system.is_unified_memory ? availRam : discreteVram;
      const offloadRatio = Math.min(1, Math.max(0, Number((gpuBudget / Math.max(1, total)).toFixed(2))));
      const numGpu = Math.round(entry.n_layers * offloadRatio);
      return {
        model: entry,
        fit: {
          fit_status: fitStatus, weight_memory_estimate: weight, runtime_overhead_estimate: overhead, kv_cache_estimate: kv, total_estimated_bytes: total, available_budget: budget, context_length: effCtx,
          expected_backend: state.bootstrap.system.is_unified_memory ? 'Metal (Unified)' : 'CPU + Hybrid GPU', performance_estimate: 'Not benchmarked yet',
          reasons: [fitStatus === 'Not recommended' ? `Estimated ${(total / GIB).toFixed(1)} GiB exceeds budget ${(budget / GIB).toFixed(1)} GiB.` : `Fits under ${execProfile} (${kvType} KV, ${numGpu}/${entry.n_layers} GPU layers).`],
          source, confidence: state.bootstrap.analytics.available ? 'high' : 'medium',
          execution_plan: { profile: execProfile, kv_cache_type: kvType, num_ctx: effCtx, num_gpu: numGpu, num_batch: execProfile === 'constrained_memory' ? 256 : 512, num_ubatch: 128, num_thread: Math.max(2, state.bootstrap.system.physical_cores ?? 4), use_mmap: true, use_mlock: false, keep_alive: '5m', flash_attention: true, num_parallel: state.bootstrap.settings.num_parallel, offload_ratio: offloadRatio, warnings: fitStatus === 'Borderline' ? ['Memory pressure possible under long context.'] : [] },
        },
      };
    });
  };

  const handleCommand = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case 'get_app_state': syncActiveLibrary(); return structuredClone(state.bootstrap);
      case 'get_telemetry': return { ...state.bootstrap.telemetry, sampled_at: new Date().toISOString() };
      case 'select_external_library': {
        const volId = String(args.volumeIdentifier ?? args.volume_identifier ?? '');
        const vol = state.bootstrap.external_volumes.find((v) => v.volume_identifier === volId);
        if (!vol || !vol.writable) throw `selected volume is not writable: ${volId}`;
        const dir = `${vol.mount_path}/MOSAIC/ollama-models`;
        state.bootstrap.active_library = { volume_identifier: vol.volume_identifier, label: vol.label, mount_path: vol.mount_path, filesystem: vol.filesystem, media_kind: vol.media_kind, directory_path: dir, ollama_configured: state.bootstrap.ollama.env_ollama_models === dir, free_bytes: vol.free_bytes, total_bytes: vol.total_bytes, verified_at: new Date().toISOString() };
        state.bootstrap.library_connected = true;
        pushDiag('info', 'volume_manager', `Selected external library ${vol.label}`);
        return structuredClone(state.bootstrap.active_library);
      }
      case 'update_setting':
      case 'set_setting': {
        const key = String(args.key ?? ''), s = state.bootstrap.settings;
        if (!SETTINGS.has(key)) throw `setting key not allowed: ${key}`;
        if (key === 'ollama_endpoint') {
          const url = String(args.value ?? '');
          if (!LOOPBACK_RE.test(url)) throw `endpoint must be loopback (127.0.0.1 or localhost) by default: ${url}`;
          s.ollama_endpoint = url;
        } else if (key === 'safety_reserve_gib') s.safety_reserve_gib = Math.min(16, Math.max(0.5, Number(args.value)));
        else if (key === 'execution_profile') { s.execution_profile = String(args.value); state.executionProfile = s.execution_profile as MutableFixtureState['executionProfile']; }
        else if (key === 'kv_cache_type') { s.kv_cache_type = String(args.value); if (s.kv_cache_type !== 'auto') state.kvCacheType = s.kv_cache_type as MutableFixtureState['kvCacheType']; }
        else if (key === 'num_thread' || key === 'num_batch' || key === 'num_ubatch') s[key] = args.value == null ? null : Number(args.value);
        else if (key === 'ollama_management_mode' || key === 'keep_alive') s[key] = String(args.value);
        else if (key === 'telemetry_poll_ms' || key === 'default_context_length' || key === 'max_loaded_models' || key === 'num_parallel') s[key] = Number(args.value);
        return structuredClone(s);
      }
      case 'get_diagnostics': return structuredClone(state.diagnostics.slice(0, Math.min(200, Math.max(1, Number(args.limit ?? 50)))));
      case 'list_catalog_with_fit':
      case 'evaluate_catalog': return evaluateCatalog(args);
      case 'refresh_model_catalog':
        if (state.catalogRefreshFails) throw 'Catalog refresh failed: network unreachable';
        pushDiag('info', 'model_catalog', 'Refreshed catalog metadata via HTTPS');
        return { updated: true, count: state.catalogEntries.length, refreshed_at: new Date().toISOString() };
      case 'pull_model': {
        const model = String(args.model ?? '');
        validateModel(model);
        if (!state.bootstrap.library_connected || !state.bootstrap.active_library) throw 'external model library is not connected or configured';
        if (state.activePulls[model]) throw `Pull already active for ${model}.`;
        const est = args.estimatedBytes ?? args.estimated_bytes;
        const total = typeof est === 'number' ? est : 1_000_000_000;
        const reqBytes = Math.floor(total * 1.1);
        if (est != null && state.bootstrap.active_library.free_bytes < reqBytes) throw `insufficient free space on external drive: required ${reqBytes} bytes, available ${state.bootstrap.active_library.free_bytes} bytes`;
        const pullEntry = { completed: 0, total, cancelled: false };
        state.activePulls[model] = pullEntry;
        emitBackendEvent('mosaic://pull-progress', { model, status: 'pulling manifest', completed: 0, total, done: false, error: null });
        window.setTimeout(() => {
          if (pullEntry.cancelled || state.activePulls[model] !== pullEntry) return;
          pullEntry.completed = Math.floor(total * 0.25);
          emitBackendEvent('mosaic://pull-progress', { model, status: 'downloading', completed: pullEntry.completed, total, done: false, error: null });
          window.setTimeout(() => {
            if (pullEntry.cancelled || state.activePulls[model] !== pullEntry) return;
            pullEntry.completed = Math.floor(total * 0.65);
            emitBackendEvent('mosaic://pull-progress', { model, status: 'downloading', completed: pullEntry.completed, total, done: false, error: null });
            window.setTimeout(() => {
              if (pullEntry.cancelled || state.activePulls[model] !== pullEntry) return;
              delete state.activePulls[model];
              if (!state.installed.some((m) => m.name === model)) state.installed.push({ name: model, size_bytes: total, digest: 'sha256:e2e000112233', modified_at: new Date().toISOString(), family: 'qwen', parameter_size: '0.5B', quantization_level: 'Q4_K_M' });
              emitBackendEvent('mosaic://pull-progress', { model, status: 'success', completed: total, total, done: true, error: null });
            }, 900);
          }, 300);
        }, 50);
        return null;
      }
      case 'cancel_pull': {
        const model = String(args.model ?? ''), active = state.activePulls[model];
        if (!active) return false;
        active.cancelled = true;
        delete state.activePulls[model];
        emitBackendEvent('mosaic://pull-progress', { model, status: 'cancelled', completed: active.completed, total: active.total, done: true, error: 'Pull cancelled by user.' });
        return true;
      }
      case 'list_installed_models': return structuredClone(state.installed);
      case 'delete_installed_model': {
        const model = String(args.model ?? '');
        validateModel(model);
        if (args.confirmed !== true) throw 'Explicit confirmation is required before deleting model weights.';
        state.installed = state.installed.filter((m) => m.name !== model);
        pushDiag('info', 'model_library', `Deleted model ${model}`);
        return null;
      }
      case 'show_model_details': {
        const model = String(args.model ?? '');
        validateModel(model);
        if (!state.bootstrap.ollama.api_reachable || state.showFailModel === model) throw `Failed to query /api/show for ${model}`;
        const found = state.installed.find((m) => m.name === model);
        return { model, family: found?.family ?? 'llama', parameter_size: found?.parameter_size ?? '3.2B', quantization_level: found?.quantization_level ?? 'Q4_K_M', native_context_length: 131072, template: '{{ .System }}\n{{ .Prompt }}', parameters: 'temperature 0.2', license: 'Apache-2.0' };
      }
      case 'start_chat_stream': {
        const req = (args.request ?? {}) as Record<string, unknown>, model = String(req.model ?? '');
        validateModel(model);
        if (!state.bootstrap.library_connected) throw 'external model library is required before running models';
        if (!state.bootstrap.ollama.api_reachable) throw 'Ollama API is unreachable';
        const sid = String(req.session_id ?? 'session-1'), seq = ++activeChatSeq;
        state.activeInferenceSession = sid;
        window.setTimeout(() => {
          if (activeChatSeq !== seq || state.activeInferenceSession !== sid) return;
          emitBackendEvent('mosaic://chat-token', { session_id: sid, token: 'Local ', done: false, error: null });
          window.setTimeout(() => {
            if (activeChatSeq !== seq || state.activeInferenceSession !== sid) return;
            if (state.streamHttpError) { const err = state.streamHttpError; state.activeInferenceSession = null; emitBackendEvent('mosaic://chat-token', { session_id: sid, token: '', done: true, error: err }); return; }
            emitBackendEvent('mosaic://chat-token', { session_id: sid, token: 'inference ok.', done: false, error: null });
            window.setTimeout(() => { if (activeChatSeq === seq && state.activeInferenceSession === sid) { state.activeInferenceSession = null; emitBackendEvent('mosaic://chat-token', { session_id: sid, token: '', done: true, error: null }); } }, 900);
          }, 350);
        }, 50);
        return null;
      }
      case 'stop_chat_stream': {
        if (!state.activeInferenceSession) return false;
        const sid = state.activeInferenceSession;
        activeChatSeq += 1;
        state.activeInferenceSession = null;
        emitBackendEvent('mosaic://chat-token', { session_id: sid, token: '', done: true, error: null });
        return true;
      }
      case 'unload_model': validateModel(String(args.model ?? '')); if (!state.bootstrap.ollama.api_reachable) throw 'Ollama API is unreachable'; return null;
      case 'configure_ollama_storage':
        if (args.confirmed !== true) throw 'Explicit confirmation is required before configuring OLLAMA_MODELS.';
        if (!state.bootstrap.active_library) throw 'No external library selected';
        state.bootstrap.active_library.ollama_configured = true;
        state.bootstrap.ollama.env_ollama_models = state.bootstrap.active_library.directory_path;
        return `Configured OLLAMA_MODELS=${state.bootstrap.active_library.directory_path} (backup saved).`;
      case 'start_managed_ollama':
        if (args.confirmed !== true) throw 'Explicit confirmation is required to start managed Ollama.';
        if (!state.bootstrap.ollama.installed) throw 'Ollama binary is not installed';
        Object.assign(state.bootstrap.ollama, { api_reachable: true, api_version: '0.40.9', runtime_mode: 'cli_service' });
        return structuredClone(state.bootstrap.ollama);
      case 'stop_managed_ollama':
        if (args.confirmed !== true) throw 'Explicit confirmation is required to stop managed Ollama.';
        Object.assign(state.bootstrap.ollama, { api_reachable: false, api_version: null, runtime_mode: 'stopped' });
        return structuredClone(state.bootstrap.ollama);
      case 'prepare_safe_eject': {
        if (Object.keys(state.activePulls).length > 0 || state.activeInferenceSession !== null) throw 'Stop active model downloads or inference before ejecting.';
        const mount = state.bootstrap.active_library?.mount_path ?? '/Volumes/External', libId = state.bootstrap.active_library?.volume_identifier;
        state.bootstrap.library_connected = false;
        state.bootstrap.active_library = null;
        if (libId) state.bootstrap.external_volumes = state.bootstrap.external_volumes.filter((v) => v.volume_identifier !== libId);
        return `Volume at ${mount} is safe to remove.`;
      }
      case 'preview_internal_migration': return structuredClone(state.migrationPreview);
      case 'execute_internal_migration':
        if (args.confirmed !== true) throw 'Explicit confirmation is required before migrating models.';
        if (!state.bootstrap.library_connected) throw 'No external library connected.';
        if (!state.migrationPreview.fits_on_external) throw 'Insufficient free space on external drive for migration.';
        if (state.installed.length === 0) state.installed.push({ name: 'llama3.2:3b', size_bytes: 2_020_000_000, digest: 'sha256:a1b2c3d4e5f6', modified_at: new Date().toISOString(), family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' });
        return { files_copied: state.migrationPreview.blob_count, bytes_copied: state.migrationPreview.total_bytes };
      case 'list_cluster_workers': return structuredClone(state.workers);
      case 'add_cluster_worker': {
        const req = (args.request ?? {}) as Record<string, unknown>, host = String(req.host ?? '').trim(), port = Number(req.port ?? 0);
        if (host === '169.254.169.254' || host === 'metadata.google.internal') throw `SSRF policy blocked metadata host: ${host}`;
        if (port < 1024 || port > 65535) throw `Invalid RPC port ${port}; must be 1024-65535`;
        if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !req.allow_lan) throw `Non-loopback host ${host} requires explicit LAN opt-in.`;
        const worker = { id: `wrk-${state.workers.length + 1}`, name: String(req.name || host), host, port, vram_bytes: Number(req.vram_gib ?? 0) * GIB, ram_available_bytes: Number(req.ram_gib ?? 0) * GIB, backend: String(req.backend ?? 'ggml_rpc'), status: 'configured', rtt_ms: null, created_at: new Date().toISOString() };
        state.workers.push(worker);
        return structuredClone(worker);
      }
      case 'remove_cluster_worker': state.workers = state.workers.filter((w) => w.id !== String(args.id ?? '')); return null;
      case 'probe_cluster_workers': state.workers = state.workers.map((w, i) => ({ ...w, status: 'reachable', rtt_ms: 2 + i })); return structuredClone(state.workers);
      case 'plan_adaptive_execution': {
        const name = String(args.ollamaName ?? args.ollama_name ?? ''), rpcArg = state.workers.map((w) => `${w.host}:${w.port}`).join(',');
        return {
          strategy: state.workers.length > 0 ? '3-Tier MoE + RPC Pool' : 'Unified Metal Hybrid', feasible: true, is_moe: /moe|235b|30b/.test(name),
          total_demand_bytes: 48 * GIB, tier1_gpu_bytes: 12 * GIB, tier2_ram_bytes: 24 * GIB, tier3_disk_mmap_bytes: 12 * GIB,
          node_allocations: [{ name: 'Local Host', role: 'primary', endpoint: '127.0.0.1', allocated_bytes: 10 * GIB, budget_bytes: 12 * GIB }, ...state.workers.map((w) => ({ name: w.name, role: 'rpc_worker', endpoint: `${w.host}:${w.port}`, allocated_bytes: Math.round(w.vram_bytes * 0.8), budget_bytes: w.vram_bytes }))],
          runtime_flags: state.workers.length > 0 ? ['-ot', 'exps=CPU', '--rpc', rpcArg, '-fa', 'on'] : ['-fa', 'on'], warnings: [],
        };
      }
      case 'launch_cluster_runtime': {
        if (!state.bootstrap.library_connected) throw 'External library required before launching cluster runtime.';
        if (args.confirmed !== true) throw 'Explicit confirmation is required before launching cluster runtime.';
        const gguf = String(args.ggufRelPath ?? args.modelGgufRelPath ?? args.model_gguf_rel_path ?? '');
        if (!gguf || gguf.includes('..') || gguf.startsWith('/') || !gguf.toLowerCase().endsWith('.gguf')) throw `InvalidPath: invalid GGUF path ${gguf}`;
        for (const f of (args.runtimeFlags ?? args.extraFlags ?? args.extra_flags ?? []) as string[]) {
          if (f.startsWith('-') && !FLAGS.has(f)) throw `Disallowed runtime flag: ${f}`;
          if (/[;&|`$]/.test(f)) throw `Disallowed shell metacharacter in flag: ${f}`;
        }
        state.clusterRuntimeRunning = true;
        pushDiag('info', 'cluster_manager', `Launched llama-server for ${gguf}`);
        return 'http://127.0.0.1:11435';
      }
      case 'stop_cluster_runtime': { const was = state.clusterRuntimeRunning; state.clusterRuntimeRunning = false; return was; }
      case 'run_model_benchmark': {
        const model = String(args.model ?? '');
        validateModel(model);
        const rec = { id: `rep-${Date.now()}`, model_name: model, context_length: Number(args.contextLength ?? args.context_length ?? 4096), storage_media_kind: state.bootstrap.active_library?.media_kind ?? 'unknown', cold_load_ms: 1950, warm_load_ms: 170, ttft_median_ms: 132, tok_per_sec_median: 46.4, peak_ram_bytes: Math.round(2.9 * GIB), repetitions: Number(args.repetitions ?? 2), raw_report_json: JSON.stringify({ model }), created_at: new Date().toISOString() };
        state.reports.unshift(rec);
        return structuredClone(rec);
      }
      case 'list_benchmark_reports': return structuredClone(state.reports.slice(0, Number(args.limit ?? 50)));
      case 'export_benchmark_report': {
        if (state.exportReportFails) throw 'Failed to export benchmark report.';
        const rep = state.reports.find((r) => r.id === String(args.reportId ?? args.report_id ?? '')) ?? state.reports[0];
        if (!rep) throw 'Report not found';
        const fmt = String(args.format ?? 'json');
        if (fmt === 'html') return { format: 'html', content: `<html><body><h1>${escapeHtml(rep.model_name)}</h1></body></html>` };
        if (fmt === 'csv') return { format: 'csv', content: `model,tok_per_sec\n${rep.model_name},${rep.tok_per_sec_median ?? 0}\n` };
        return { format: 'json', content: JSON.stringify(rep, null, 2) };
      }
      case 'analyze_hardware_insights': return { ram_total_bytes: state.bootstrap.system.ram_total_bytes, ram_effective_avail_bytes: state.bootstrap.system.ram_available_bytes, metal_wired_limit_bytes: state.bootstrap.system.is_unified_memory ? Math.round(10.66 * GIB) : null, gpu_devices: state.bootstrap.system.gpus, limitations: state.bootstrap.system.gpus.length === 0 ? ['No supported GPU telemetry library'] : [] };
      case 'analyze_benchmark_performance': return { report_id: String(args.reportId ?? args.report_id ?? ''), bottlenecks: [{ category: 'storage_throughput', severity: 'medium', summary: 'ExFAT USB cold load overhead detected.' }], efficiency_ratio: 0.78, suggestions: ['Use q8_0 KV cache and warm-keep-alive for repeated prompts.'] };
      default: throw `Unhandled mock Tauri command: ${cmd}`;
    }
  };
  window.isTauri = true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string, eventId: number) => unlistenEvent(event, eventId) };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    convertFileSrc: (filePath: string, protocol = 'asset') => `${protocol}://localhost/${encodeURIComponent(filePath)}`,
    transformCallback: (fn: (data: unknown) => void, once = false) => { const id = nextId++; callbacks.set(id, { fn, once }); return id; },
    unregisterCallback, runCallback,
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'plugin:event|listen') { const e = String(args.event ?? ''), h = Number(args.handler); eventListeners.set(e, [...(eventListeners.get(e) ?? []), h]); return h; }
      if (cmd === 'plugin:event|unlisten') { unlistenEvent(String(args.event ?? ''), Number(args.eventId ?? args.id)); return null; }
      if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') { emitBackendEvent(String(args.event ?? ''), args.payload); return null; }
      invokeLog.push({ cmd, args: structuredClone(args), ts: Date.now() });
      return handleCommand(cmd, args);
    },
  };
  window.__MOSAIC_E2E__ = {
    profile: state.profile, invokeLog, emittedEvents, state, emitBackendEvent,
    hasEventListener: (event) => (eventListeners.get(event)?.length ?? 0) > 0,
    setVolumes: (volumes) => { state.bootstrap.external_volumes = structuredClone(volumes); syncActiveLibrary(); },
    setFreeBytes: (id, freeBytes) => {
      const vol = state.bootstrap.external_volumes.find((v) => v.volume_identifier === id);
      if (vol) vol.free_bytes = freeBytes;
      if (state.bootstrap.active_library?.volume_identifier === id) state.bootstrap.active_library.free_bytes = freeBytes;
    },
    setOllamaReachable: (reachable, version = null) => Object.assign(state.bootstrap.ollama, { api_reachable: reachable, api_version: reachable ? version ?? '0.40.9' : null, runtime_mode: reachable ? 'cli_service' : 'stopped' }),
  };
}
export async function installTauriMock(page: Page, profile: FixtureProfileId = 'connected-16gb-m3'): Promise<void> {
  await page.addInitScript(initTauriRuntime, createFixtureState(profile));
}
