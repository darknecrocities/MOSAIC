import type { AppBootstrapState, NavRoute } from '../types/ipc';
import { formatGiB } from '../utils/format';

interface OverviewScreenProps {
  state: AppBootstrapState;
  installedCount?: number;
  onNavigate: (route: NavRoute) => void;
}

export function OverviewScreen({ state, installedCount = 0, onNavigate }: OverviewScreenProps) {
  return (
    <div className="mosaic-workstation-grid">
      <section className="mosaic-panel" aria-labelledby="ov-hw">
        <div className="mosaic-panel-header">
          <h2 id="ov-hw">Host Hardware</h2>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">CPU</span>
          <span>{state.system.cpu_brand}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Accelerator</span>
          <span>{state.system.gpu_status}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Available RAM</span>
          <span className="mosaic-num">
            {formatGiB(state.telemetry.ram_available_bytes)} / {formatGiB(state.telemetry.ram_total_bytes)}
          </span>
        </div>
        <div className="mosaic-card-actions">
          <button
            type="button"
            className="mosaic-button-secondary"
            onClick={() => onNavigate('hardware')}
          >
            View Hardware Diagnostics
          </button>
        </div>
      </section>

      <section className="mosaic-panel" aria-labelledby="ov-storage">
        <div className="mosaic-panel-header">
          <h2 id="ov-storage">External Model Library</h2>
          <span className="mosaic-status-inline">
            <span className={state.library_connected ? 'mosaic-status-dot mosaic-status-dot-ok' : 'mosaic-status-dot mosaic-status-dot-warn'} />
            <span>{state.library_connected ? 'Connected' : 'Action Required'}</span>
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
              <span className="mosaic-num">{formatGiB(state.active_library.free_bytes)}</span>
            </div>
          </>
        ) : (
          <p className="mosaic-subtitle">Select an external drive to unlock model downloads.</p>
        )}
        <div className="mosaic-card-actions">
          <button
            type="button"
            className="mosaic-button-secondary"
            onClick={() => onNavigate('storage')}
          >
            Manage External Storage
          </button>
        </div>
      </section>

      <section className="mosaic-panel" aria-labelledby="ov-runtime">
        <div className="mosaic-panel-header">
          <h2 id="ov-runtime">Runtime &amp; Models</h2>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Ollama Runtime</span>
          <span>
            {state.ollama.api_reachable ? `Online (${state.ollama.api_version ?? 'ok'})` : 'Offline'}
          </span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Installed Models</span>
          <span className="mosaic-num">{installedCount}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Default Profile</span>
          <span>{state.settings.execution_profile}</span>
        </div>
        <div className="mosaic-card-actions">
          <button
            type="button"
            className="mosaic-button"
            onClick={() => onNavigate(installedCount > 0 ? 'run' : 'discover')}
          >
            {installedCount > 0 ? 'Launch Chat' : 'Discover Models'}
          </button>
        </div>
      </section>
    </div>
  );
}
