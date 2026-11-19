import { useState } from 'react';
import { PullProgressBanner } from './components/common/PullProgressBanner';
import { AppShell } from './components/layout/AppShell';
import { OnboardingGate } from './components/onboarding/OnboardingGate';
import { useMosaicRuntime } from './hooks/useMosaicRuntime';
import { DiscoverModelsScreen } from './screens/DiscoverModelsScreen';
import { ExternalStorageScreen } from './screens/ExternalStorageScreen';
import { HardwareScreen } from './screens/HardwareScreen';
import { MyModelsScreen } from './screens/MyModelsScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { RunModelScreen } from './screens/RunModelScreen';
import { SettingsScreen } from './screens/SettingsScreen';

export function App() {
  const rt = useMosaicRuntime();
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);

  const showOnboarding =
    (!rt.state || !rt.state.library_connected) &&
    rt.route !== 'hardware' &&
    rt.route !== 'settings' &&
    !(rt.state && rt.route === 'storage');

  return (
    <AppShell
      activeRoute={rt.route}
      onNavigate={rt.setRoute}
      state={rt.state}
      loading={rt.loading}
      onRefresh={() => {
        void rt.loadState();
        void rt.loadInstalled();
      }}
    >
      {rt.notice && (
        <section className="mosaic-callout mosaic-callout-info" role="status" aria-live="polite">
          <strong>Status:</strong> {rt.notice}
        </section>
      )}
      {rt.pullProgress && !rt.pullProgress.done && (
        <PullProgressBanner pullProgress={rt.pullProgress} onCancelPull={rt.handleCancelPull} />
      )}
      {showOnboarding && (
        <OnboardingGate
          volumes={rt.state?.external_volumes ?? []}
          selecting={rt.selecting}
          onSelectVolume={(id) => void rt.handleSelectVolume(id)}
          onInspectHardware={() => rt.setRoute('hardware')}
        />
      )}
      {rt.state && rt.route === 'overview' && (
        <OverviewScreen
          state={rt.state}
          installedCount={rt.installed.length}
          onNavigate={rt.setRoute}
        />
      )}
      {rt.route === 'discover' && (
        <DiscoverModelsScreen
          items={rt.catalog}
          loading={rt.catalogLoading}
          contextLength={rt.contextLength}
          executionProfile={rt.executionProfile}
          kvCacheType={rt.kvCacheType}
          lastCatalogRefresh={rt.lastCatalogRefresh}
          refreshingCatalog={refreshingCatalog}
          libraryConnected={Boolean(rt.state?.library_connected)}
          freeBytes={rt.state?.active_library?.free_bytes ?? 0}
          pullingName={rt.pullProgress && !rt.pullProgress.done ? rt.pullProgress.model : null}
          onChangeContextLength={rt.setContextLength}
          onChangeExecutionProfile={rt.setExecutionProfile}
          onChangeKvCacheType={rt.setKvCacheType}
          onRefreshCatalog={() => {
            setRefreshingCatalog(true);
            void rt.handleRefreshCatalog().finally(() => setRefreshingCatalog(false));
          }}
          onPullModel={(name) => void rt.handlePullModel(name)}
        />
      )}
      {rt.route === 'my-models' && (
        <MyModelsScreen
          models={rt.installed}
          reports={rt.reports}
          loading={rt.loading}
          libraryConnected={Boolean(rt.state?.library_connected)}
          benchmarkingModel={rt.benchmarkingModel}
          onRefresh={() => void rt.loadInstalled()}
          onLaunchModel={(name) => {
            rt.setSelectedModel(name);
            rt.setRoute('run');
          }}
          onRunBenchmark={(model, contextLength, repetitions) =>
            rt.handleRunBenchmark({
              model,
              contextLength: contextLength ?? rt.contextLength,
              repetitions: repetitions ?? 2,
              executionProfile: rt.executionProfile,
              kvCacheType: rt.kvCacheType,
            })
          }
          onExportReport={(id, fmt) => void rt.handleExportReport(id, fmt)}
          onDeleteModel={rt.handleDeleteModel}
        />
      )}
      {rt.route === 'run' && (
        <RunModelScreen
          models={rt.installed}
          selectedModel={rt.selectedModel}
          libraryConnected={Boolean(rt.state?.library_connected)}
          ollamaReachable={Boolean(rt.state?.ollama.api_reachable)}
          streaming={rt.streaming}
          messages={rt.messages}
          telemetry={rt.state?.telemetry}
          defaultContextLength={rt.state?.settings.default_context_length ?? rt.contextLength}
          executionProfile={rt.executionProfile}
          kvCacheType={rt.kvCacheType}
          onSelectModel={rt.setSelectedModel}
          onSendMessage={(prompt, numCtx, temperature, opts) =>
            void rt.handleSendMessage(prompt, {
              numCtx,
              temperature,
              executionProfile: opts?.executionProfile ?? rt.executionProfile,
              kvCacheType: opts?.kvCacheType ?? rt.kvCacheType,
              numGpu: opts?.numGpu ?? null,
              keepAlive: rt.state?.settings.keep_alive ?? '5m',
            })
          }
          onStopGeneration={rt.handleStopGeneration}
          onUnloadModel={rt.handleUnloadModel}
          onNewSession={rt.handleNewSession}
          onStartManagedOllama={rt.handleStartManagedOllama}
        />
      )}
      {rt.route === 'hardware' &&
        (rt.state ? (
          <HardwareScreen state={rt.state} />
        ) : (
          <section className="mosaic-panel" aria-labelledby="hw-empty">
            <h2 id="hw-empty">Hardware &amp; Memory Profile</h2>
            <p className="mosaic-subtitle">
              Hardware telemetry requires the native MOSAIC Tauri runtime.
            </p>
          </section>
        ))}
      {rt.state && rt.route === 'storage' && (
        <ExternalStorageScreen
          state={rt.state}
          selecting={rt.selecting}
          onSelectVolume={(id) => void rt.handleSelectVolume(id)}
          onInspectHardware={() => rt.setRoute('hardware')}
          onConfigureOllamaStorage={rt.handleConfigureOllamaStorage}
          onStartManagedOllama={rt.handleStartManagedOllama}
          onStopManagedOllama={rt.handleStopManagedOllama}
          onSafeEject={rt.handleSafeEject}
        />
      )}
      {rt.state && rt.route === 'settings' && (
        <SettingsScreen
          settings={rt.state.settings}
          onSaveSetting={rt.handleSaveSetting}
        />
      )}
    </AppShell>
  );
}

export default App;
