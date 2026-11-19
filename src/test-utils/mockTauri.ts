import {
  SAMPLE_BOOTSTRAP,
  SAMPLE_CATALOG,
  SAMPLE_CLUSTER_PLAN,
  SAMPLE_DIAGNOSTICS,
  SAMPLE_HARDWARE_INSIGHTS,
  SAMPLE_MODELS,
  SAMPLE_PERFORMANCE_ANALYSIS,
  SAMPLE_REPORTS,
  SAMPLE_SHOW_DETAILS,
  SAMPLE_WORKERS,
} from './mockFixtures';

type CommandHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface TauriInvocationRecord {
  cmd: string;
  args: Record<string, unknown>;
}

export interface TauriTestController {
  invocations: TauriInvocationRecord[];
  callsFor: (cmd: string) => TauriInvocationRecord[];
  listenerCount: (event: string) => number;
  emit: (event: string, payload: unknown) => void;
  setHandler: (cmd: string, fn: CommandHandler) => void;
  deferListen: (event: string) => () => void;
  uninstall: () => void;
}

interface ListenerRecord {
  id: number;
  callbackId: number;
}

export function installTauriTestBridge(
  initialHandlers?: Record<string, CommandHandler>
): TauriTestController {
  let nextCallbackId = 1;
  let nextEventId = 1;
  const callbacks = new Map<number, (data: unknown) => void>();
  const listeners = new Map<string, ListenerRecord[]>();
  const deferredListens = new Map<string, Array<() => void>>();
  const invocations: TauriInvocationRecord[] = [];
  const handlers = new Map<string, CommandHandler>(Object.entries(initialHandlers ?? {}));

  const defaults: Record<string, CommandHandler> = {
    get_app_state: () => structuredClone(SAMPLE_BOOTSTRAP),
    get_telemetry: () => structuredClone(SAMPLE_BOOTSTRAP.telemetry),
    list_installed_models: () => structuredClone(SAMPLE_MODELS),
    list_benchmark_reports: () => structuredClone(SAMPLE_REPORTS),
    list_catalog_with_fit: () => structuredClone(SAMPLE_CATALOG),
    refresh_model_catalog: () => ({ count: SAMPLE_CATALOG.length, source_url: 'https://example.invalid/catalog.json', refreshed_at: '2026-11-18T10:10:00Z' }),
    select_external_library: () => structuredClone(SAMPLE_BOOTSTRAP.active_library),
    update_setting: (args) => ({ ...SAMPLE_BOOTSTRAP.settings, [String(args.key)]: args.value }),
    get_diagnostics: () => structuredClone(SAMPLE_DIAGNOSTICS),
    analyze_hardware_insights: () => structuredClone(SAMPLE_HARDWARE_INSIGHTS),
    analyze_benchmark_performance: () => structuredClone(SAMPLE_PERFORMANCE_ANALYSIS),
    show_model_details: () => structuredClone(SAMPLE_SHOW_DETAILS),
    list_cluster_workers: () => structuredClone(SAMPLE_WORKERS),
    add_cluster_worker: () => structuredClone(SAMPLE_WORKERS[0]),
    probe_cluster_workers: () => structuredClone(SAMPLE_WORKERS),
    remove_cluster_worker: () => undefined,
    plan_adaptive_execution: () => structuredClone(SAMPLE_CLUSTER_PLAN),
    launch_cluster_runtime: () => 'Cluster llama-server launched.',
    stop_cluster_runtime: () => true,
    pull_model: () => undefined,
    cancel_pull: () => true,
    delete_installed_model: () => undefined,
    start_chat_stream: () => undefined,
    stop_chat_stream: () => true,
    unload_model: () => undefined,
    configure_ollama_storage: () => '/tmp/backup',
    start_managed_ollama: () => structuredClone(SAMPLE_BOOTSTRAP.ollama),
    stop_managed_ollama: () => ({ ...SAMPLE_BOOTSTRAP.ollama, api_reachable: false }),
    prepare_safe_eject: () => 'Safe to eject.',
    preview_internal_migration: () => ({ source_dir: '~/.ollama/models', exists: true, blob_count: 2, manifest_count: 1, total_bytes: 2 * 1024 ** 3, fits_on_external: true }),
    execute_internal_migration: () => ({ files_copied: 3, bytes_copied: 2 * 1024 ** 3 }),
    run_model_benchmark: () => structuredClone(SAMPLE_REPORTS[0]),
    export_benchmark_report: (args) => ({ format: String(args.format ?? 'json'), content: '{"ok":true}' }),
  };

  const win = window as unknown as Record<string, unknown>;
  const prevIsTauri = win.isTauri;
  const prevInternals = win.__TAURI_INTERNALS__;
  const prevEventInternals = win.__TAURI_EVENT_PLUGIN_INTERNALS__;

  const removeListener = (event: string, eventId: number) => {
    const list = listeners.get(event) ?? [];
    listeners.set(event, list.filter((entry) => entry.id !== eventId));
  };

  win.isTauri = true;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => removeListener(event, eventId),
  };
  win.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    convertFileSrc: (path: string) => path,
    transformCallback: (cb: (data: unknown) => void, once = false) => {
      const id = nextCallbackId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        cb(data);
      });
      return id;
    },
    unregisterCallback: (id: number) => { callbacks.delete(id); },
    runCallback: (id: number, data: unknown) => { callbacks.get(id)?.(data); },
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'plugin:event|listen') {
        const event = String(args.event ?? '');
        const callbackId = Number(args.handler);
        const waiters = deferredListens.get(event);
        if (waiters !== undefined) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        const id = nextEventId++;
        const current = listeners.get(event) ?? [];
        current.push({ id, callbackId });
        listeners.set(event, current);
        return id;
      }
      if (cmd === 'plugin:event|unlisten') {
        removeListener(String(args.event ?? ''), Number(args.eventId ?? args.id ?? -1));
        return null;
      }
      invocations.push({ cmd, args });
      const handler = handlers.get(cmd) ?? defaults[cmd];
      if (!handler) throw new Error(`Unhandled Tauri test command: ${cmd}`);
      return handler(args);
    },
  };

  return {
    invocations,
    callsFor: (cmd: string) => invocations.filter((item) => item.cmd === cmd),
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    emit: (event: string, payload: unknown) => {
      for (const entry of [...(listeners.get(event) ?? [])]) {
        callbacks.get(entry.callbackId)?.({ event, id: entry.id, payload });
      }
    },
    setHandler: (cmd: string, fn: CommandHandler) => { handlers.set(cmd, fn); },
    deferListen: (event: string) => {
      const queue: Array<() => void> = [];
      deferredListens.set(event, queue);
      return () => {
        deferredListens.delete(event);
        for (const fn of queue) fn();
      };
    },
    uninstall: () => {
      listeners.clear();
      callbacks.clear();
      if (prevIsTauri === undefined) delete win.isTauri;
      else win.isTauri = prevIsTauri;
      if (prevInternals === undefined) delete win.__TAURI_INTERNALS__;
      else win.__TAURI_INTERNALS__ = prevInternals;
      if (prevEventInternals === undefined) delete win.__TAURI_EVENT_PLUGIN_INTERNALS__;
      else win.__TAURI_EVENT_PLUGIN_INTERNALS__ = prevEventInternals;
    },
  };
}
