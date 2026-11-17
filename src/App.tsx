import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { OnboardingGate } from './components/onboarding/OnboardingGate';
import { DiscoverModelsScreen } from './screens/DiscoverModelsScreen';
import { ExternalStorageScreen } from './screens/ExternalStorageScreen';
import { HardwareScreen } from './screens/HardwareScreen';
import { MyModelsScreen } from './screens/MyModelsScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { RunModelScreen } from './screens/RunModelScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import type {
  AppBootstrapState,
  CatalogModelWithFit,
  ChatMessage,
  ChatTokenEvent,
  InstalledModel,
  NavRoute,
  PullProgressEvent,
  ResourceTelemetry,
} from './types/ipc';

export function App() {
  const [route, setRoute] = useState<NavRoute>('overview');
  const [state, setState] = useState<AppBootstrapState | null>(null);
  const [catalog, setCatalog] = useState<CatalogModelWithFit[]>([]);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [pullProgress, setPullProgress] = useState<PullProgressEvent | null>(null);
  const [contextLength, setContextLength] = useState<number>(4096);
  const [loading, setLoading] = useState<boolean>(false);
  const [catalogLoading, setCatalogLoading] = useState<boolean>(false);
  const [selecting, setSelecting] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef<string>('session-1');

  const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const loadState = useCallback(async () => {
    if (!isTauri()) {
      setNotice('Browser preview mode: launch the MOSAIC desktop window to access live hardware, external drives, and Ollama.');
      return;
    }
    setLoading(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const next = await invoke<AppBootstrapState>('get_app_state');
      setState(next);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to query MOSAIC native core.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInstalled = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const list = await invoke<InstalledModel[]>('list_installed_models');
      setInstalled(list);
      if (!selectedModel && list.length > 0) setSelectedModel(list[0].name);
    } catch {
      // Ollama offline.
    }
  }, [selectedModel]);

  useEffect(() => {
    void loadState();
    void loadInstalled();
  }, [loadState, loadInstalled]);

  useEffect(() => {
    if (!isTauri()) return;
    const intervalMs = state?.settings.telemetry_poll_ms ?? 5000;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const telemetry = await invoke<ResourceTelemetry>('get_telemetry');
          setState((prev) => (prev ? { ...prev, telemetry } : prev));
        } catch {
          // Ignore transient polling errors.
        }
      })();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [state?.settings.telemetry_poll_ms]);

  useEffect(() => {
    let unlistenPull: (() => void) | undefined;
    let unlistenChat: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenPull = await listen<PullProgressEvent>('mosaic://pull-progress', (ev) => {
          setPullProgress(ev.payload);
          if (ev.payload.done) void loadInstalled();
        });
        unlistenChat = await listen<ChatTokenEvent>('mosaic://chat-token', (ev) => {
          if (ev.payload.error) {
            setNotice(ev.payload.error);
            setStreaming(false);
            return;
          }
          if (ev.payload.token) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, content: last.content + ev.payload.token }];
              }
              return [...prev, { role: 'assistant', content: ev.payload.token }];
            });
          }
          if (ev.payload.done) setStreaming(false);
        });
      } catch {
        // Non-Tauri browser preview.
      }
    })();

    return () => {
      unlistenPull?.();
      unlistenChat?.();
    };
  }, [loadInstalled]);

  useEffect(() => {
    if (route !== 'discover') return;
    setCatalogLoading(true);
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const items = await invoke<CatalogModelWithFit[]>('list_catalog_with_fit', {
          contextLength,
        });
        setCatalog(items);
      } catch {
        // Browser preview fallback.
      } finally {
        setCatalogLoading(false);
      }
    })();
  }, [route, contextLength]);

  const invokeAndRefresh = async (cmd: string, args?: Record<string, unknown>, okMsg?: string) => {
    setNotice(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<string>(cmd, args);
      if (okMsg) setNotice(typeof res === 'string' && res ? res : okMsg);
      await loadState();
      await loadInstalled();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectVolume = async (volumeIdentifier: string) => {
    setSelecting(true);
    await invokeAndRefresh('select_external_library', { volumeIdentifier });
    setSelecting(false);
  };

  const handlePullModel = async (ollamaName: string) => {
    const found = catalog.find((c) => c.model.ollama_name === ollamaName);
    await invokeAndRefresh('pull_model', {
      model: ollamaName,
      estimatedBytes: found?.model.download_size_bytes ?? null,
    });
  };

  const handleSendMessage = async (prompt: string, numCtx: number, temperature: number) => {
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: prompt }];
    setMessages(nextMessages);
    setStreaming(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('start_chat_stream', {
        request: {
          session_id: sessionRef.current,
          model: selectedModel,
          messages: nextMessages,
          num_ctx: numCtx,
          temperature,
        },
      });
    } catch (err) {
      setStreaming(false);
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const showOnboarding = !state || !state.library_connected;

  return (
    <AppShell
      activeRoute={route}
      onNavigate={setRoute}
      state={state}
      loading={loading}
      onRefresh={() => {
        void loadState();
        void loadInstalled();
      }}
    >
      {notice && (
        <section className="mosaic-panel" role="status" aria-live="polite">
          <strong>Status:</strong> {notice}
        </section>
      )}
      {pullProgress && !pullProgress.done && (
        <section className="mosaic-panel" role="status">
          Pulling <strong>{pullProgress.model}</strong>: {pullProgress.status}
        </section>
      )}
      {showOnboarding && route !== 'hardware' && route !== 'settings' && (
        <OnboardingGate
          volumes={state?.external_volumes ?? []}
          selecting={selecting}
          onSelectVolume={(id) => void handleSelectVolume(id)}
          onInspectHardware={() => setRoute('hardware')}
        />
      )}
      {state && route === 'overview' && <OverviewScreen state={state} onNavigate={setRoute} />}
      {route === 'discover' && (
        <DiscoverModelsScreen
          items={catalog}
          loading={catalogLoading}
          contextLength={contextLength}
          libraryConnected={Boolean(state?.library_connected)}
          freeBytes={state?.active_library?.free_bytes ?? 0}
          pullingName={pullProgress && !pullProgress.done ? pullProgress.model : null}
          onChangeContextLength={setContextLength}
          onPullModel={(name) => void handlePullModel(name)}
        />
      )}
      {route === 'my-models' && (
        <MyModelsScreen
          models={installed}
          loading={loading}
          libraryConnected={Boolean(state?.library_connected)}
          onRefresh={() => void loadInstalled()}
          onLaunchModel={(name) => {
            setSelectedModel(name);
            setRoute('run');
          }}
          onDeleteModel={(name) =>
            invokeAndRefresh('delete_installed_model', { model: name, confirmed: true })
          }
        />
      )}
      {route === 'run' && (
        <RunModelScreen
          models={installed}
          selectedModel={selectedModel}
          libraryConnected={Boolean(state?.library_connected)}
          ollamaReachable={Boolean(state?.ollama.api_reachable)}
          streaming={streaming}
          messages={messages}
          telemetry={state?.telemetry}
          onSelectModel={setSelectedModel}
          onSendMessage={(p, c, t) => void handleSendMessage(p, c, t)}
          onStopGeneration={() => void invokeAndRefresh('stop_chat_stream')}
          onUnloadModel={() => void invokeAndRefresh('unload_model', { model: selectedModel })}
        />
      )}
      {route === 'hardware' &&
        (state ? (
          <HardwareScreen state={state} />
        ) : (
          <section className="mosaic-panel" aria-labelledby="hw-empty">
            <h2 id="hw-empty">Hardware &amp; Memory Profile</h2>
            <p className="mosaic-subtitle">
              Hardware telemetry requires the native MOSAIC Tauri runtime.
            </p>
          </section>
        ))}
      {state && route === 'storage' && (
        <ExternalStorageScreen
          state={state}
          selecting={selecting}
          onSelectVolume={(id) => void handleSelectVolume(id)}
          onInspectHardware={() => setRoute('hardware')}
          onConfigureOllamaStorage={() =>
            invokeAndRefresh(
              'configure_ollama_storage',
              { confirmed: true },
              'OLLAMA_MODELS configured.'
            )
          }
          onSafeEject={() =>
            invokeAndRefresh('prepare_safe_eject', undefined, 'Drive is safe to remove.')
          }
        />
      )}
      {state && route === 'settings' && (
        <SettingsScreen
          settings={state.settings}
          onSaveSetting={(key, value) => invokeAndRefresh('update_setting', { key, value })}
        />
      )}
    </AppShell>
  );
}

export default App;
