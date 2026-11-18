import { useCallback, useEffect, useState } from 'react';
import { FolderSync, Play, Power, Square, Wrench } from 'lucide-react';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { OnboardingGate } from '../components/onboarding/OnboardingGate';
import type { AppBootstrapState, MigrationPreview } from '../types/ipc';
import { formatGiB } from '../utils/format';
import { mosaicApi } from '../utils/mosaicApi';
import { isTauriRuntime, toErrorMessage } from '../utils/tauriClient';

interface ExternalStorageScreenProps {
  state: AppBootstrapState;
  selecting: boolean;
  onSelectVolume: (id: string) => void;
  onInspectHardware: () => void;
  onConfigureOllamaStorage: () => Promise<void>;
  onStartManagedOllama?: () => Promise<void>;
  onStopManagedOllama?: () => Promise<void>;
  onSafeEject: () => Promise<void>;
}

type ConfirmMode = 'ollama' | 'start-ollama' | 'stop-ollama' | 'eject' | 'migrate' | null;

export function ExternalStorageScreen({
  state,
  selecting,
  onSelectVolume,
  onInspectHardware,
  onConfigureOllamaStorage,
  onStartManagedOllama,
  onStopManagedOllama,
  onSafeEject,
}: ExternalStorageScreenProps) {
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null);
  const [migrationPreview, setMigrationPreview] = useState<MigrationPreview | null>(null);
  const [migrationStatus, setMigrationStatus] = useState<string | null>(null);

  const loadMigrationPreview = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      setMigrationPreview(await mosaicApi.previewInternalMigration());
    } catch { /* Ignore in browser preview. */ }
  }, []);

  useEffect(() => {
    void loadMigrationPreview();
  }, [loadMigrationPreview]);

  const handleMigrate = async () => {
    if (!isTauriRuntime()) return;
    setMigrationStatus('Copying internal models to external drive...');
    try {
      const res = await mosaicApi.executeInternalMigration(true);
      setMigrationStatus(
        `Copied ${res.files_copied} file(s) (${formatGiB(res.bytes_copied)}) to external library.`
      );
    } catch (err) {
      setMigrationStatus(toErrorMessage(err));
    }
  };

  return (
    <div className="mosaic-stack">
      {state.active_library && (
        <section className="mosaic-panel" aria-labelledby="active-lib-heading">
          <div className="mosaic-panel-header">
            <h2 id="active-lib-heading">Active External Library</h2>
            <span className="mosaic-status-inline">
              <span className={state.library_connected ? 'mosaic-status-dot mosaic-status-dot-ok' : 'mosaic-status-dot mosaic-status-dot-warn'} />
              <span>{state.library_connected ? 'Connected & Writable' : 'Disconnected'}</span>
            </span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Directory</span>
            <code>{state.active_library.directory_path}</code>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Volume UUID</span>
            <code>{state.active_library.volume_identifier}</code>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Filesystem / Media</span>
            <span>{state.active_library.filesystem} ({state.active_library.media_kind})</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Capacity</span>
            <span className="mosaic-num">
              {formatGiB(state.active_library.free_bytes)} free / {formatGiB(state.active_library.total_bytes)}
            </span>
          </div>

          <div className="mosaic-card-actions">
            <button
              type="button"
              className="mosaic-button-secondary"
              disabled={!state.library_connected}
              onClick={() => setConfirmMode('ollama')}
            >
              <Wrench size={15} aria-hidden="true" />
              <span>Configure OLLAMA_MODELS</span>
            </button>
            {onStartManagedOllama && !state.ollama.api_reachable && (
              <button
                type="button"
                className="mosaic-button"
                disabled={!state.library_connected}
                onClick={() => setConfirmMode('start-ollama')}
              >
                <Play size={15} aria-hidden="true" />
                <span>Start Managed Ollama</span>
              </button>
            )}
            {onStopManagedOllama && state.ollama.api_reachable && (
              <button
                type="button"
                className="mosaic-button-danger"
                onClick={() => setConfirmMode('stop-ollama')}
              >
                <Square size={15} aria-hidden="true" />
                <span>Stop Managed Ollama</span>
              </button>
            )}
            <button
              type="button"
              className="mosaic-button-danger"
              disabled={!state.library_connected}
              onClick={() => setConfirmMode('eject')}
            >
              <Power size={15} aria-hidden="true" />
              <span>Prepare Eject</span>
            </button>
            {migrationPreview?.exists && migrationPreview.total_bytes > 0 && (
              <button
                type="button"
                className="mosaic-button-secondary"
                disabled={!state.library_connected || !migrationPreview.fits_on_external}
                onClick={() => setConfirmMode('migrate')}
              >
                <FolderSync size={15} aria-hidden="true" />
                <span>Migrate Models ({formatGiB(migrationPreview.total_bytes)})</span>
              </button>
            )}
          </div>
          {migrationStatus && (
            <p className="mosaic-callout mosaic-callout-info" role="status">{migrationStatus}</p>
          )}
        </section>
      )}

      <OnboardingGate
        volumes={state.external_volumes}
        selecting={selecting}
        onSelectVolume={onSelectVolume}
        onInspectHardware={onInspectHardware}
      />

      <ConfirmModal
        open={confirmMode === 'ollama'}
        title="Configure Ollama Storage Directory"
        description={`Back up existing Ollama settings and set OLLAMA_MODELS to ${state.active_library?.directory_path ?? ''}?`}
        confirmLabel="Apply Configuration"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => { setConfirmMode(null); void onConfigureOllamaStorage(); }}
      />
      <ConfirmModal
        open={confirmMode === 'start-ollama'}
        title="Start Managed Ollama"
        description={`Launch supervised Ollama using OLLAMA_MODELS=${state.active_library?.directory_path ?? ''} with adaptive Flash Attention and KV cache environment settings?`}
        confirmLabel="Start Managed Ollama"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => { setConfirmMode(null); void onStartManagedOllama?.(); }}
      />
      <ConfirmModal
        open={confirmMode === 'stop-ollama'}
        title="Stop Managed Ollama"
        description="Stop the supervised Ollama daemon managed by MOSAIC?"
        confirmLabel="Stop Managed Ollama"
        variant="danger"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => { setConfirmMode(null); void onStopManagedOllama?.(); }}
      />
      <ConfirmModal
        open={confirmMode === 'eject'}
        title="Prepare External Drive for Safe Removal"
        description="Stop active model operations, flush pending writes, and eject the external model library volume?"
        confirmLabel="Eject Safely"
        variant="danger"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => { setConfirmMode(null); void onSafeEject(); }}
      />
      <ConfirmModal
        open={confirmMode === 'migrate'}
        title="Copy Internal Ollama Models to External Drive"
        description={`Copy ${migrationPreview?.blob_count ?? 0} blob(s) (${formatGiB(migrationPreview?.total_bytes ?? 0)}) from ${migrationPreview?.source_dir ?? '~/.ollama/models'} to your external library?`}
        confirmLabel="Copy to External Drive"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => { setConfirmMode(null); void handleMigrate(); }}
      />
    </div>
  );
}
