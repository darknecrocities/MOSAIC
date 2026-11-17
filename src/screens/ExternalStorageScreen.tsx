import { useCallback, useEffect, useState } from 'react';
import { FolderSync, Power, Wrench } from 'lucide-react';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { OnboardingGate } from '../components/onboarding/OnboardingGate';
import type { AppBootstrapState, MigrationPreview } from '../types/ipc';
import { formatGiB } from '../utils/format';

interface ExternalStorageScreenProps {
  state: AppBootstrapState;
  selecting: boolean;
  onSelectVolume: (id: string) => void;
  onInspectHardware: () => void;
  onConfigureOllamaStorage: () => Promise<void>;
  onSafeEject: () => Promise<void>;
}

export function ExternalStorageScreen({
  state,
  selecting,
  onSelectVolume,
  onInspectHardware,
  onConfigureOllamaStorage,
  onSafeEject,
}: ExternalStorageScreenProps) {
  const [confirmMode, setConfirmMode] = useState<'ollama' | 'eject' | 'migrate' | null>(null);
  const [migrationPreview, setMigrationPreview] = useState<MigrationPreview | null>(null);
  const [migrationStatus, setMigrationStatus] = useState<string | null>(null);

  const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const loadMigrationPreview = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setMigrationPreview(await invoke<MigrationPreview>('preview_internal_migration'));
    } catch {
      // Ignore in browser preview.
    }
  }, []);

  useEffect(() => {
    void loadMigrationPreview();
  }, [loadMigrationPreview]);

  const handleMigrate = async () => {
    if (!isTauri()) return;
    setMigrationStatus('Copying internal models to external drive...');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ files_copied: number; bytes_copied: number }>(
        'execute_internal_migration',
        { confirmed: true }
      );
      setMigrationStatus(
        `Copied ${res.files_copied} file(s) (${formatGiB(res.bytes_copied)}) to external library.`
      );
    } catch (err) {
      setMigrationStatus(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {state.active_library && (
        <section className="mosaic-panel" aria-labelledby="active-lib-heading">
          <div className="mosaic-panel-header">
            <h2 id="active-lib-heading">Active External Library</h2>
            <span
              className={
                state.library_connected
                  ? 'mosaic-badge mosaic-badge-success'
                  : 'mosaic-badge mosaic-badge-error'
              }
            >
              {state.library_connected ? 'Connected & Writable' : 'Disconnected'}
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
            <span>
              {state.active_library.filesystem} ({state.active_library.media_kind})
            </span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Capacity</span>
            <span>
              {formatGiB(state.active_library.free_bytes)} free /{' '}
              {formatGiB(state.active_library.total_bytes)}
            </span>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="mosaic-button-secondary"
              disabled={!state.library_connected}
              onClick={() => setConfirmMode('ollama')}
            >
              <Wrench size={15} aria-hidden="true" />
              <span>Configure OLLAMA_MODELS</span>
            </button>
            <button
              type="button"
              className="mosaic-button"
              disabled={!state.library_connected}
              onClick={() => setConfirmMode('eject')}
            >
              <Power size={15} aria-hidden="true" />
              <span>Stop model and prepare drive for removal</span>
            </button>
            {migrationPreview?.exists && migrationPreview.total_bytes > 0 && (
              <button
                type="button"
                className="mosaic-button-secondary"
                disabled={!state.library_connected || !migrationPreview.fits_on_external}
                onClick={() => setConfirmMode('migrate')}
              >
                <FolderSync size={15} aria-hidden="true" />
                <span>
                  Migrate Internal Models ({formatGiB(migrationPreview.total_bytes)})
                </span>
              </button>
            )}
          </div>
          {migrationStatus && (
            <p className="mosaic-subtitle" role="status" style={{ marginTop: 8 }}>
              {migrationStatus}
            </p>
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
        description={`Back up existing Ollama settings and set OLLAMA_MODELS to ${state.active_library?.directory_path ?? ''}? You may need to restart Ollama for changes to take effect.`}
        confirmLabel="Apply Configuration"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => {
          setConfirmMode(null);
          void onConfigureOllamaStorage();
        }}
      />

      <ConfirmModal
        open={confirmMode === 'eject'}
        title="Prepare External Drive for Safe Removal"
        description="Stop active model operations, flush pending writes, and eject the external model library volume?"
        confirmLabel="Eject Safely"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => {
          setConfirmMode(null);
          void onSafeEject();
        }}
      />

      <ConfirmModal
        open={confirmMode === 'migrate'}
        title="Copy Internal Ollama Models to External Drive"
        description={`Copy ${migrationPreview?.blob_count ?? 0} blob(s) (${formatGiB(migrationPreview?.total_bytes ?? 0)}) from ${migrationPreview?.source_dir ?? '~/.ollama/models'} to your external library? Original internal files will not be deleted automatically.`}
        confirmLabel="Copy to External Drive"
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => {
          setConfirmMode(null);
          void handleMigrate();
        }}
      />
    </div>
  );
}
