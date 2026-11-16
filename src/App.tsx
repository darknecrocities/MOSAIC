import { useCallback, useEffect, useState } from 'react';
import { Activity, Cpu, HardDrive, RefreshCw, Terminal } from 'lucide-react';
import type { SpikeReport } from './types/ipc';

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function App() {
  const [report, setReport] = useState<SpikeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const loadDiagnostics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke<SpikeReport>('get_spike_diagnostics');
      setReport(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tauri runtime unavailable in browser preview.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  return (
    <div className="mosaic-shell">
      <header className="mosaic-topbar">
        <div>
          <div className="mosaic-brand">
            <Cpu size={20} color="#2878B8" aria-hidden="true" />
            <span>MOSAIC</span>
          </div>
          <div className="mosaic-subtitle">
            Local-first model orchestration with mandatory external storage
          </div>
        </div>
        <button
          type="button"
          className="mosaic-button"
          onClick={() => void loadDiagnostics()}
          disabled={loading}
          aria-label="Refresh system and runtime diagnostics"
        >
          <RefreshCw size={16} aria-hidden="true" />
          <span>{loading ? 'Scanning...' : 'Rescan Host'}</span>
        </button>
      </header>

      <main className="mosaic-main">
        {error && (
          <section className="mosaic-panel" role="status" aria-live="polite">
            <strong>Runtime notice:</strong> {error}
          </section>
        )}

        <div className="mosaic-grid">
          <section className="mosaic-panel" aria-labelledby="heading-hardware">
            <div className="mosaic-panel-header">
              <h2 id="heading-hardware">System Probe</h2>
              <Activity size={18} color="#2878B8" aria-hidden="true" />
            </div>
            {report ? (
              <div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">OS / Arch</span>
                  <span>
                    {report.system.os_name} ({report.system.architecture})
                  </span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">CPU</span>
                  <span>{report.system.cpu_brand}</span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Memory</span>
                  <span>
                    {formatGiB(report.system.ram_available_bytes)} free /{' '}
                    {formatGiB(report.system.ram_total_bytes)}
                  </span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">GPU Mode</span>
                  <span className="mosaic-badge">{report.system.gpu_status}</span>
                </div>
              </div>
            ) : (
              <p className="mosaic-subtitle">Awaiting native probe from Tauri core.</p>
            )}
          </section>

          <section className="mosaic-panel" aria-labelledby="heading-storage">
            <div className="mosaic-panel-header">
              <h2 id="heading-storage">External Model Library</h2>
              <HardDrive size={18} color="#2878B8" aria-hidden="true" />
            </div>
            {report && report.external_volumes.length > 0 ? (
              report.external_volumes.map((vol) => (
                <div key={vol.volume_identifier} className="mosaic-kv">
                  <span className="mosaic-kv-label">
                    {vol.label} ({vol.filesystem})
                  </span>
                  <span>{formatGiB(vol.free_bytes)} free</span>
                </div>
              ))
            ) : (
              <p className="mosaic-subtitle">
                No external drive selected. Connect an external HDD or SSD to enable model
                downloads; internal disk fallback is disabled.
              </p>
            )}
          </section>

          <section className="mosaic-panel" aria-labelledby="heading-runtime">
            <div className="mosaic-panel-header">
              <h2 id="heading-runtime">Ollama &amp; Analytics</h2>
              <Terminal size={18} color="#2878B8" aria-hidden="true" />
            </div>
            {report ? (
              <div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Ollama API</span>
                  <span
                    className={
                      report.ollama.api_reachable
                        ? 'mosaic-badge'
                        : 'mosaic-badge mosaic-badge-warn'
                    }
                  >
                    {report.ollama.api_reachable ? 'Reachable' : 'Offline'}
                  </span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Python Worker</span>
                  <span
                    className={
                      report.analytics.available
                        ? 'mosaic-badge'
                        : 'mosaic-badge mosaic-badge-warn'
                    }
                  >
                    {report.analytics.available
                      ? `v${report.analytics.service_version ?? '1.0'}`
                      : 'Unavailable'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="mosaic-subtitle">Awaiting Ollama and Python worker status.</p>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
