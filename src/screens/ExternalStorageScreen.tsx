import { useState } from 'react';
import { Power, Wrench } from 'lucide-react';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { OnboardingGate } from '../components/onboarding/OnboardingGate';
import type { AppBootstrapState } from '../types/ipc';
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
  const [confirmMode, setConfirmMode] = useState<'ollama' | 'eject' | null>(null);

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
          </div>
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
    </div>
  );
}
