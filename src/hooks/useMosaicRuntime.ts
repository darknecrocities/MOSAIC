import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppBootstrapState, BenchmarkReportRecord, CatalogModelWithFit, ChatMessage,
  ExecutionProfile, InstalledModel, KvCacheType, NavRoute, PullProgressEvent,
} from '../types/ipc';
import { mosaicApi } from '../utils/mosaicApi';
import { isTauriRuntime, toErrorMessage, triggerFileDownload } from '../utils/tauriClient';
import { useMosaicEvents } from './useMosaicEvents';

function createSessionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export interface ChatSendOptions {
  numCtx: number; temperature: number; executionProfile: ExecutionProfile;
  kvCacheType: KvCacheType; numGpu: number | null; keepAlive: string;
}

export interface BenchmarkRunOptions {
  model: string; contextLength: number; repetitions: number;
  executionProfile: ExecutionProfile; kvCacheType: KvCacheType;
}

export function useMosaicRuntime() {
  const [route, setRoute] = useState<NavRoute>('overview');
  const [state, setState] = useState<AppBootstrapState | null>(null);
  const [catalog, setCatalog] = useState<CatalogModelWithFit[]>([]);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [reports, setReports] = useState<BenchmarkReportRecord[]>([]);
  const [benchmarkingModel, setBenchmarkingModel] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [pullProgress, setPullProgress] = useState<PullProgressEvent | null>(null);
  const [contextLength, setContextLength] = useState<number>(4096);
  const [executionProfile, setExecutionProfile] = useState<ExecutionProfile>('auto_adaptive');
  const [kvCacheType, setKvCacheType] = useState<KvCacheType>('auto');
  const [lastCatalogRefresh, setLastCatalogRefresh] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [catalogLoading, setCatalogLoading] = useState<boolean>(false);
  const [selecting, setSelecting] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const routeRef = useRef(route);
  routeRef.current = route;
  const contextLengthRef = useRef(contextLength);
  contextLengthRef.current = contextLength;
  const executionProfileRef = useRef(executionProfile);
  executionProfileRef.current = executionProfile;
  const kvCacheTypeRef = useRef(kvCacheType);
  kvCacheTypeRef.current = kvCacheType;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const catalogReqIdRef = useRef(0);
  const activeSessionIdRef = useRef<string>(createSessionId());
  const defaultsSyncedRef = useRef(false);

  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  const loadState = useCallback(async () => {
    if (!isTauriRuntime()) {
      setNotice('Browser preview mode: launch the MOSAIC desktop window to access live hardware, external drives, and Ollama.');
      return;
    }
    setLoading(true);
    try {
      const next = await mosaicApi.getAppState();
      if (!isMountedRef.current) return;
      setState(next);
      if (!defaultsSyncedRef.current) {
        defaultsSyncedRef.current = true;
        setContextLength(next.settings.default_context_length || 4096);
        setExecutionProfile((next.settings.execution_profile as ExecutionProfile) || 'auto_adaptive');
        setKvCacheType((next.settings.kv_cache_type as KvCacheType) || 'auto');
      }
    } catch (err) {
      if (isMountedRef.current) setNotice(toErrorMessage(err, 'Failed to query MOSAIC native core.'));
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, []);

  const loadInstalled = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const list = await mosaicApi.listInstalledModels();
      if (!isMountedRef.current) return;
      setInstalled(list);
      if (!selectedModelRef.current && list.length > 0) setSelectedModel(list[0].name);
    } catch { /* Ollama offline. */ }
  }, []);

  const loadReports = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const next = await mosaicApi.listBenchmarkReports();
      if (isMountedRef.current) setReports(next);
    } catch { /* DB unavailable. */ }
  }, []);

  useEffect(() => {
    void loadState();
    void loadInstalled();
    void loadReports();
  }, [loadState, loadInstalled, loadReports]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const timer = window.setInterval(() => {
      void mosaicApi.getTelemetry()
        .then((telemetry) => { if (isMountedRef.current) setState((prev) => (prev ? { ...prev, telemetry } : prev)); })
        .catch(() => {});
    }, state?.settings.telemetry_poll_ms ?? 5000);
    return () => window.clearInterval(timer);
  }, [state?.settings.telemetry_poll_ms]);

  const onPullDone = useCallback(() => {
    void loadInstalled();
    void loadState();
  }, [loadInstalled, loadState]);

  useMosaicEvents({
    isMountedRef, activeSessionIdRef, onPullProgress: setPullProgress,
    onPullDone, setMessages, setStreaming, setNotice,
  });

  const fetchCatalog = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const reqId = ++catalogReqIdRef.current;
    setCatalogLoading(true);
    try {
      const items = await mosaicApi.listCatalogWithFit(
        contextLengthRef.current,
        executionProfileRef.current,
        kvCacheTypeRef.current
      );
      if (isMountedRef.current && catalogReqIdRef.current === reqId) {
        setCatalog(items);
      }
    } catch (err) {
      if (isMountedRef.current && catalogReqIdRef.current === reqId) {
        setNotice(toErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && catalogReqIdRef.current === reqId) {
        setCatalogLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (route !== 'discover' || !isTauriRuntime()) return;
    void fetchCatalog();
    return () => { catalogReqIdRef.current += 1; };
  }, [route, contextLength, executionProfile, kvCacheType, fetchCatalog]);

  const runAction = useCallback(async (fn: () => Promise<string | void>, okMsg?: string) => {
    setNotice(null);
    try {
      const res = await fn();
      if (!isMountedRef.current) return;
      if (okMsg) setNotice(typeof res === 'string' && res ? res : okMsg);
      await Promise.all([loadState(), loadInstalled()]);
    } catch (err) {
      if (isMountedRef.current) setNotice(toErrorMessage(err));
    }
  }, [loadState, loadInstalled]);

  return {
    route, setRoute, state, catalog, installed, reports, benchmarkingModel,
    selectedModel, setSelectedModel, messages, streaming, pullProgress,
    contextLength, setContextLength, executionProfile, setExecutionProfile,
    kvCacheType, setKvCacheType, lastCatalogRefresh, loading, catalogLoading,
    selecting, notice, setNotice, loadState, loadInstalled,
    handleSelectVolume: async (volumeIdentifier: string) => {
      setSelecting(true);
      await runAction(() => mosaicApi.selectExternalLibrary(volumeIdentifier).then(() => undefined));
      if (isMountedRef.current && routeRef.current === 'discover') {
        await fetchCatalog();
      }
      if (isMountedRef.current) setSelecting(false);
    },
    handleRefreshCatalog: async () => {
      setNotice(null);
      const refreshStartReqId = catalogReqIdRef.current;
      try {
        const res = await mosaicApi.refreshModelCatalog();
        if (!isMountedRef.current) return;
        setLastCatalogRefresh(res.refreshed_at);
        setNotice(`Catalog refreshed (${res.count} models).`);
        if (catalogReqIdRef.current === refreshStartReqId || routeRef.current === 'discover') {
          await fetchCatalog();
        }
      } catch (err) {
        if (isMountedRef.current) setNotice(toErrorMessage(err));
      }
    },
    handlePullModel: (ollamaName: string) => {
      const found = catalog.find((c) => c.model.ollama_name === ollamaName);
      return runAction(() => mosaicApi.pullModel(ollamaName, found?.model.download_size_bytes ?? null));
    },
    handleCancelPull: (model: string) => {
      void mosaicApi.cancelPull(model)
        .then((cancelled) => {
          if (isMountedRef.current && !cancelled) {
            setPullProgress((prev) => (prev && prev.model === model ? { ...prev, done: true } : null));
          }
        })
        .catch((err) => {
          if (isMountedRef.current) {
            setPullProgress(null);
            setNotice(toErrorMessage(err));
          }
        });
    },
    handleDeleteModel: (name: string) => runAction(() => mosaicApi.deleteInstalledModel(name, true), `Deleted ${name}.`),
    handleSendMessage: async (prompt: string, opts: ChatSendOptions) => {
      if (streamingRef.current) return;
      const reqSessionId = activeSessionIdRef.current;
      const nextMessages: ChatMessage[] = [...messagesRef.current, { role: 'user', content: prompt }];
      messagesRef.current = nextMessages;
      streamingRef.current = true;
      setMessages(nextMessages);
      setStreaming(true);
      setNotice(null);
      try {
        await mosaicApi.startChatStream({
          session_id: reqSessionId, model: selectedModelRef.current, messages: nextMessages,
          num_ctx: opts.numCtx, temperature: opts.temperature, execution_profile: opts.executionProfile,
          kv_cache_type: opts.kvCacheType === 'auto' ? null : opts.kvCacheType,
          num_gpu: opts.numGpu, keep_alive: opts.keepAlive || null,
        });
      } catch (err) {
        if (isMountedRef.current && activeSessionIdRef.current === reqSessionId) {
          streamingRef.current = false;
          setStreaming(false);
          setNotice(toErrorMessage(err));
        }
      }
    },
    handleStopGeneration: () => {
      void mosaicApi.stopChatStream()
        .then((stopped) => {
          if (isMountedRef.current && !stopped) {
            streamingRef.current = false;
            setStreaming(false);
          }
        })
        .catch((err) => {
          if (isMountedRef.current) {
            streamingRef.current = false;
            setStreaming(false);
            setNotice(toErrorMessage(err));
          }
        });
    },
    handleUnloadModel: () => runAction(() => mosaicApi.unloadModel(selectedModelRef.current), `Unloaded ${selectedModelRef.current}.`),
    handleNewSession: () => {
      if (streamingRef.current) {
        void mosaicApi.stopChatStream().catch(() => {});
      }
      activeSessionIdRef.current = createSessionId();
      streamingRef.current = false;
      messagesRef.current = [];
      setMessages([]);
      setStreaming(false);
    },
    handleRunBenchmark: async (opts: BenchmarkRunOptions) => {
      setBenchmarkingModel(opts.model);
      setNotice(null);
      try {
        await mosaicApi.runModelBenchmark(opts);
        await loadReports();
        if (isMountedRef.current) setNotice(`Benchmark complete for ${opts.model}.`);
      } catch (err) {
        if (isMountedRef.current) setNotice(toErrorMessage(err));
      } finally {
        if (isMountedRef.current) setBenchmarkingModel(null);
      }
    },
    handleExportReport: async (reportId: string, format: 'json' | 'csv' | 'html') => {
      try {
        const res = await mosaicApi.exportBenchmarkReport(reportId, format);
        triggerFileDownload(`mosaic-benchmark-${reportId.slice(0, 8)}.${res.format}`, res.content);
      } catch (err) {
        if (isMountedRef.current) setNotice(toErrorMessage(err));
      }
    },
    handleConfigureOllamaStorage: () => runAction(() => mosaicApi.configureOllamaStorage(true), 'OLLAMA_MODELS configured.'),
    handleStartManagedOllama: () => runAction(() => mosaicApi.startManagedOllama(true).then(() => undefined), 'Managed Ollama started.'),
    handleStopManagedOllama: () => runAction(() => mosaicApi.stopManagedOllama(true).then(() => undefined), 'Managed Ollama stopped.'),
    handleSafeEject: () => runAction(() => mosaicApi.prepareSafeEject(), 'Drive is safe to remove.'),
    handleSaveSetting: async (key: string, value: unknown) => {
      const next = await mosaicApi.updateSetting(key, value);
      if (!isMountedRef.current) return;
      setState((prev) => (prev ? { ...prev, settings: next } : prev));
      if (key === 'default_context_length') setContextLength(next.default_context_length || 4096);
      if (key === 'execution_profile') setExecutionProfile((next.execution_profile as ExecutionProfile) || 'auto_adaptive');
      if (key === 'kv_cache_type') setKvCacheType((next.kv_cache_type as KvCacheType) || 'auto');
    },
  };
}
