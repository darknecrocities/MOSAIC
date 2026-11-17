import { useCallback, useEffect, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { OnboardingGate } from './components/onboarding/OnboardingGate';
import { ExternalStorageScreen } from './screens/ExternalStorageScreen';
import { DiscoverModelsScreen } from './screens/DiscoverModelsScreen';
import { HardwareScreen } from './screens/HardwareScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import type { AppBootstrapState, CatalogModelWithFit, NavRoute } from './types/ipc';

export function App() {
  const [route, setRoute] = useState<NavRoute>('overview');
  const [state, setState] = useState<AppBootstrapState | null>(null);
  const [catalog, setCatalog] = useState<CatalogModelWithFit[]>([]);
  const [catalogLoading, setCatalogLoading] = useState<boolean>(false);
  const [contextLength, setContextLength] = useState<number>(4096);
  const [loading, setLoading] = useState<boolean>(false);
  const [selecting, setSelecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const next = await invoke<AppBootstrapState>('get_app_state');
      setState(next);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Tauri native core unavailable in browser preview.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const loadCatalog = useCallback(async (ctxLen: number) => {
    setCatalogLoading(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const items = await invoke<CatalogModelWithFit[]>('list_catalog_with_fit', {
        contextLength: ctxLen,
      });
      setCatalog(items);
    } catch {
      // Catalog stays empty in non-Tauri browser preview.
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (route === 'discover') {
      void loadCatalog(contextLength);
    }
  }, [route, contextLength, loadCatalog]);

  const handleSelectVolume = async (volumeIdentifier: string) => {
    setSelecting(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('select_external_library', { volumeIdentifier });
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate external volume.');
    } finally {
      setSelecting(false);
    }
  };

  const handleSaveSetting = async (key: string, value: unknown) => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('update_setting', { key, value });
    await loadState();
  };

  const showOnboarding = !state || !state.library_connected;

  return (
    <AppShell
      activeRoute={route}
      onNavigate={setRoute}
      state={state}
      loading={loading}
      onRefresh={() => void loadState()}
    >
      {error && (
        <section className="mosaic-panel" role="status" aria-live="polite">
          <strong>Runtime notice:</strong> {error}
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
      {state && route === 'hardware' && <HardwareScreen state={state} />}
      {state && route === 'storage' && (
        <ExternalStorageScreen
          state={state}
          selecting={selecting}
          onSelectVolume={(id) => void handleSelectVolume(id)}
          onInspectHardware={() => setRoute('hardware')}
        />
      )}
      {state && route === 'settings' && (
        <SettingsScreen settings={state.settings} onSaveSetting={handleSaveSetting} />
      )}
      {route === 'discover' && (
        <DiscoverModelsScreen
          items={catalog}
          loading={catalogLoading}
          contextLength={contextLength}
          libraryConnected={Boolean(state?.library_connected)}
          freeBytes={state?.active_library?.free_bytes ?? 0}
          pullingName={null}
          onChangeContextLength={setContextLength}
        />
      )}
      {route === 'my-models' && (
        <PlaceholderScreen
          title="My Models"
          description="Installed external-drive model inventory and verified removal controls arrive in Milestone D."
          requiresDrive
          libraryConnected={Boolean(state?.library_connected)}
        />
      )}
      {route === 'run' && (
        <PlaceholderScreen
          title="Run Model"
          description="Local streaming chat and runtime memory controls arrive in Milestone D."
          requiresDrive
          libraryConnected={Boolean(state?.library_connected)}
        />
      )}
    </AppShell>
  );
}

export default App;
