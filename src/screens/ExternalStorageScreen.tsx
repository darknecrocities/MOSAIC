import type { AppBootstrapState } from '../types/ipc';
import { OnboardingGate } from '../components/onboarding/OnboardingGate';
import { formatGiB } from '../utils/format';

interface ExternalStorageScreenProps {
  state: AppBootstrapState;
  selecting: boolean;
  onSelectVolume: (id: string) => void;
  onInspectHardware: () => void;
}

export function ExternalStorageScreen({
  state,
  selecting,
  onSelectVolume,
  onInspectHardware,
}: ExternalStorageScreenProps) {
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
        </section>
      )}

      <OnboardingGate
        volumes={state.external_volumes}
        selecting={selecting}
        onSelectVolume={onSelectVolume}
        onInspectHardware={onInspectHardware}
      />
    </div>
  );
}
