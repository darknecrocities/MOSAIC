import type { AppBootstrapState, NavRoute } from '../types/ipc';
import { formatGiB } from '../utils/format';

interface OverviewScreenProps {
  state: AppBootstrapState;
  onNavigate: (route: NavRoute) => void;
}

export function OverviewScreen({ state, onNavigate }: OverviewScreenProps) {
  return (
    <div className="mosaic-grid">
      <section className="mosaic-panel" aria-labelledby="ov-hw">
        <div className="mosaic-panel-header">
          <h2 id="ov-hw">Host Hardware</h2>
          <span className="mosaic-badge">{state.system.gpu_status}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">CPU</span>
          <span>{state.system.cpu_brand}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Available RAM</span>
          <span>
            {formatGiB(state.telemetry.ram_available_bytes)} /{' '}
            {formatGiB(state.telemetry.ram_total_bytes)}
          </span>
        </div>
        <button
          type="button"
          className="mosaic-button-secondary"
          style={{ marginTop: 12 }}
          onClick={() => onNavigate('hardware')}
        >
          View Full Hardware Diagnostics
        </button>
      </section>

      <section className="mosaic-panel" aria-labelledby="ov-storage">
        <div className="mosaic-panel-header">
          <h2 id="ov-storage">External Model Library</h2>
          <span
            className={
              state.library_connected
                ? 'mosaic-badge mosaic-badge-success'
                : 'mosaic-badge mosaic-badge-warn'
            }
          >
            {state.library_connected ? 'Connected' : 'Action Required'}
          </span>
        </div>
        {state.active_library ? (
          <>
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">Volume</span>
              <span>{state.active_library.label}</span>
            </div>
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">Free Capacity</span>
              <span>{formatGiB(state.active_library.free_bytes)}</span>
            </div>
          </>
        ) : (
          <p className="mosaic-subtitle">Select an external drive to unlock model downloads.</p>
        )}
        <button
          type="button"
          className="mosaic-button-secondary"
          style={{ marginTop: 12 }}
          onClick={() => onNavigate('storage')}
        >
          Manage External Storage
        </button>
      </section>
    </div>
  );
}
