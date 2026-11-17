import type { AppBootstrapState } from '../types/ipc';
import { formatGiB } from '../utils/format';

export function HardwareScreen({ state }: { state: AppBootstrapState }) {
  const { system, ollama, analytics } = state;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="mosaic-panel" aria-labelledby="hw-profile-title">
        <div className="mosaic-panel-header">
          <h2 id="hw-profile-title">Hardware &amp; Memory Profile</h2>
          <span className="mosaic-badge">measured</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Operating System</span>
          <span>
            {system.os_name} {system.os_version} ({system.architecture})
          </span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Processor</span>
          <span>
            {system.cpu_brand} ({system.physical_cores ?? '?'}P / {system.logical_cores}T)
          </span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Total / Available RAM</span>
          <span>
            {formatGiB(system.ram_available_bytes)} free of {formatGiB(system.ram_total_bytes)}
          </span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Unified Memory</span>
          <span>{system.is_unified_memory ? 'Yes (CPU & GPU shared)' : 'No'}</span>
        </div>
      </section>

      <section className="mosaic-panel" aria-labelledby="hw-runtime-title">
        <div className="mosaic-panel-header">
          <h2 id="hw-runtime-title">Runtime &amp; Analytics</h2>
          <span className="mosaic-badge">{ollama.runtime_mode}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Ollama CLI / API</span>
          <span>
            {ollama.cli_version ?? 'not found'} /{' '}
            {ollama.api_reachable ? `reachable (${ollama.api_version ?? 'ok'})` : 'offline'}
          </span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Python Analytics Worker</span>
          <span>
            {analytics.available
              ? `Healthy (protocol ${analytics.protocol_version ?? '1.0'})`
              : analytics.error ?? 'Unavailable'}
          </span>
        </div>
      </section>
    </div>
  );
}
