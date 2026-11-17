import { useCallback, useEffect, useState } from 'react';
import { Network, Plus, Trash2 } from 'lucide-react';
import type { AppSettingsSnapshot, ClusterWorker } from '../types/ipc';
import { formatGiB } from '../utils/format';

interface SettingsScreenProps {
  settings: AppSettingsSnapshot;
  onSaveSetting: (key: string, value: unknown) => Promise<void>;
}

export function SettingsScreen({ settings, onSaveSetting }: SettingsScreenProps) {
  const [reserve, setReserve] = useState<number>(settings.safety_reserve_gib);
  const [endpoint, setEndpoint] = useState<string>(settings.ollama_endpoint);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [workers, setWorkers] = useState<ClusterWorker[]>([]);
  const [workerName, setWorkerName] = useState('');
  const [workerHost, setWorkerHost] = useState('127.0.0.1');
  const [workerPort, setWorkerPort] = useState(50052);
  const [workerVram, setWorkerVram] = useState(24);
  const [workerRam, setWorkerRam] = useState(16);
  const [allowLan, setAllowLan] = useState(false);
  const [clusterNotice, setClusterNotice] = useState<string | null>(null);

  const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const loadWorkers = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setWorkers(await invoke<ClusterWorker[]>('list_cluster_workers'));
    } catch {
      // Ignore in browser preview.
    }
  }, []);

  useEffect(() => {
    void loadWorkers();
  }, [loadWorkers]);

  const handleSave = async () => {
    setSavedNotice(null);
    await onSaveSetting('safety_reserve_gib', reserve);
    await onSaveSetting('ollama_endpoint', endpoint);
    setSavedNotice('Settings saved locally to SQLite.');
  };

  const handleAddWorker = async () => {
    setClusterNotice(null);
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('add_cluster_worker', {
        request: {
          name: workerName || workerHost,
          host: workerHost,
          port: workerPort,
          vram_gib: workerVram,
          ram_gib: workerRam,
          backend: 'ggml_rpc',
          allow_lan: allowLan,
        },
      });
      setWorkerName('');
      await loadWorkers();
    } catch (err) {
      setClusterNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleProbeWorkers = async () => {
    if (!isTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    setWorkers(await invoke<ClusterWorker[]>('probe_cluster_workers'));
  };

  const handleRemoveWorker = async (id: string) => {
    if (!isTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('remove_cluster_worker', { id });
    await loadWorkers();
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="mosaic-panel" aria-labelledby="settings-heading">
        <div className="mosaic-panel-header">
          <h2 id="settings-heading">Application &amp; Runtime Settings</h2>
          <span className="mosaic-badge">Local-first</span>
        </div>

        <div style={{ display: 'grid', gap: 16, maxWidth: 520 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>OS Memory Safety Reserve (GiB)</span>
            <input
              type="number"
              min={0.5}
              max={16}
              step={0.5}
              className="mosaic-input"
              value={reserve}
              onChange={(e) => setReserve(Number(e.target.value))}
            />
            <span className="mosaic-subtitle">
              Reserved for macOS/Windows/Linux and foreground apps before recommending models.
            </span>
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Ollama Loopback Endpoint</span>
            <input
              type="url"
              className="mosaic-input"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <span className="mosaic-subtitle">
              Must remain loopback (<code>127.0.0.1</code> or <code>localhost</code>) by default.
            </span>
          </label>

          <div>
            <button type="button" className="mosaic-button" onClick={() => void handleSave()}>
              Save Settings
            </button>
          </div>

          {savedNotice && (
            <p role="status" className="mosaic-badge mosaic-badge-success">
              {savedNotice}
            </p>
          )}
        </div>
      </section>

      <section className="mosaic-panel" aria-labelledby="cluster-heading">
        <div className="mosaic-panel-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Network size={16} color="#2878B8" aria-hidden="true" />
            <h2 id="cluster-heading">Adaptive Cluster Workers (Experimental GGML_RPC)</h2>
          </div>
          <button type="button" className="mosaic-button-secondary" onClick={() => void handleProbeWorkers()}>
            Probe Reachability
          </button>
        </div>
        <p className="mosaic-subtitle">
          Pool spare VRAM/RAM from peer machines running <code>rpc-server</code> to fit 70B–200B+ models while keeping weights on your external drive.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <input
            type="text"
            className="mosaic-input"
            placeholder="Worker name (e.g. RTX-PC)"
            value={workerName}
            onChange={(e) => setWorkerName(e.target.value)}
          />
          <input
            type="text"
            className="mosaic-input"
            placeholder="Host / LAN IP"
            value={workerHost}
            onChange={(e) => setWorkerHost(e.target.value)}
          />
          <input
            type="number"
            className="mosaic-input"
            style={{ width: 96 }}
            value={workerPort}
            onChange={(e) => setWorkerPort(Number(e.target.value))}
          />
          <input
            type="number"
            className="mosaic-input"
            style={{ width: 96 }}
            aria-label="Worker VRAM GiB"
            value={workerVram}
            onChange={(e) => setWorkerVram(Number(e.target.value))}
          />
          <input
            type="number"
            className="mosaic-input"
            style={{ width: 96 }}
            aria-label="Worker RAM GiB"
            value={workerRam}
            onChange={(e) => setWorkerRam(Number(e.target.value))}
          />
          <button type="button" className="mosaic-button" onClick={() => void handleAddWorker()}>
            <Plus size={15} aria-hidden="true" />
            <span>Add Worker</span>
          </button>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input type="checkbox" checked={allowLan} onChange={(e) => setAllowLan(e.target.checked)} />
          <span className="mosaic-subtitle">Explicitly opt in to non-loopback LAN/Tailscale RPC worker IPs</span>
        </label>

        {clusterNotice && <p className="mosaic-badge mosaic-badge-warn">{clusterNotice}</p>}

        {workers.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {workers.map((w) => (
              <div key={w.id} className="mosaic-kv">
                <span>
                  {w.name} (<code>{w.host}:{w.port}</code>) · {formatGiB(w.vram_bytes)} VRAM /{' '}
                  {formatGiB(w.ram_available_bytes)} RAM
                </span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mosaic-badge">
                    {w.status}
                    {w.rtt_ms !== null ? ` (${w.rtt_ms} ms)` : ''}
                  </span>
                  <button
                    type="button"
                    className="mosaic-button-secondary"
                    aria-label={`Remove ${w.name}`}
                    onClick={() => void handleRemoveWorker(w.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
