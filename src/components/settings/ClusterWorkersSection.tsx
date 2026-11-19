import { useCallback, useEffect, useState } from 'react';
import { Network, Plus, Trash2 } from 'lucide-react';
import type { ClusterWorker } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { mosaicApi } from '../../utils/mosaicApi';
import { isTauriRuntime, toErrorMessage } from '../../utils/tauriClient';

export function ClusterWorkersSection() {
  const [workers, setWorkers] = useState<ClusterWorker[]>([]);
  const [workerName, setWorkerName] = useState('');
  const [workerHost, setWorkerHost] = useState('127.0.0.1');
  const [workerPort, setWorkerPort] = useState('50052');
  const [workerVram, setWorkerVram] = useState('24');
  const [workerRam, setWorkerRam] = useState('16');
  const [allowLan, setAllowLan] = useState(false);
  const [clusterNotice, setClusterNotice] = useState<string | null>(null);

  const loadWorkers = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      setWorkers(await mosaicApi.listClusterWorkers());
    } catch { /* Ignore in browser preview. */ }
  }, []);

  useEffect(() => {
    void loadWorkers();
  }, [loadWorkers]);

  const handleAddWorker = async () => {
    setClusterNotice(null);
    if (!isTauriRuntime()) return;
    const port = Number(workerPort);
    const vram = Number(workerVram);
    const ram = Number(workerRam);
    if (
      !workerPort.trim() ||
      !workerVram.trim() ||
      !workerRam.trim() ||
      !Number.isFinite(port) ||
      !Number.isFinite(vram) ||
      !Number.isFinite(ram)
    ) {
      setClusterNotice('Worker port, VRAM, and RAM must be valid numbers.');
      return;
    }
    try {
      await mosaicApi.addClusterWorker({
        name: workerName || workerHost,
        host: workerHost,
        port,
        vram_gib: vram,
        ram_gib: ram,
        backend: 'ggml_rpc',
        allow_lan: allowLan,
      });
      setWorkerName('');
      await loadWorkers();
    } catch (err) {
      setClusterNotice(toErrorMessage(err));
    }
  };

  const handleProbeWorkers = async () => {
    if (!isTauriRuntime()) return;
    try {
      setWorkers(await mosaicApi.probeClusterWorkers());
    } catch (err) {
      setClusterNotice(toErrorMessage(err));
    }
  };

  const handleRemoveWorker = async (id: string) => {
    if (!isTauriRuntime()) return;
    try {
      await mosaicApi.removeClusterWorker(id);
      await loadWorkers();
    } catch (err) {
      setClusterNotice(toErrorMessage(err));
    }
  };

  return (
    <section className="mosaic-panel" aria-labelledby="cluster-heading">
      <div className="mosaic-panel-header">
        <div className="mosaic-inline-row">
          <Network size={16} className="mosaic-icon-accent" aria-hidden="true" />
          <h2 id="cluster-heading">Adaptive Cluster Workers (Experimental GGML_RPC)</h2>
        </div>
        <button type="button" className="mosaic-button-secondary" onClick={() => void handleProbeWorkers()}>
          Probe Reachability
        </button>
      </div>
      <p className="mosaic-subtitle">
        Pool spare VRAM/RAM from peer machines running <code>rpc-server</code> to fit 70B–200B+ models while keeping weights on your external drive.
      </p>

      <div className="mosaic-worker-grid">
        <label className="mosaic-field">
          <span>Worker Name</span>
          <input
            type="text"
            className="mosaic-input"
            aria-label="Worker name"
            placeholder="Worker name (e.g. RTX-PC)"
            value={workerName}
            onChange={(e) => setWorkerName(e.target.value)}
          />
        </label>
        <label className="mosaic-field">
          <span>Host / LAN IP</span>
          <input
            type="text"
            className="mosaic-input"
            aria-label="Host / LAN IP"
            placeholder="Host / LAN IP"
            value={workerHost}
            onChange={(e) => setWorkerHost(e.target.value)}
          />
        </label>
        <label className="mosaic-field">
          <span>Port</span>
          <input
            type="number"
            className="mosaic-input"
            aria-label="Worker port"
            value={workerPort}
            onChange={(e) => setWorkerPort(e.target.value)}
          />
        </label>
        <label className="mosaic-field">
          <span>VRAM (GiB)</span>
          <input
            type="number"
            className="mosaic-input"
            aria-label="Worker VRAM GiB"
            value={workerVram}
            onChange={(e) => setWorkerVram(e.target.value)}
          />
        </label>
        <label className="mosaic-field">
          <span>RAM (GiB)</span>
          <input
            type="number"
            className="mosaic-input"
            aria-label="Worker RAM GiB"
            value={workerRam}
            onChange={(e) => setWorkerRam(e.target.value)}
          />
        </label>
        <button type="button" className="mosaic-button" onClick={() => void handleAddWorker()}>
          <Plus size={15} aria-hidden="true" />
          <span>Add Worker</span>
        </button>
      </div>

      <label className="mosaic-check-field">
        <input type="checkbox" checked={allowLan} onChange={(e) => setAllowLan(e.target.checked)} />
        <span className="mosaic-subtitle">Explicitly opt in to non-loopback LAN/Tailscale RPC worker IPs</span>
      </label>

      {clusterNotice && <p role="status" className="mosaic-callout mosaic-callout-warn">{clusterNotice}</p>}

      {workers.length > 0 && (
        <div className="mosaic-stack-sm">
          {workers.map((w) => (
            <div key={w.id} className="mosaic-kv">
              <span>
                {w.name} (<code>{w.host}:{w.port}</code>) · {formatGiB(w.vram_bytes)} VRAM /{' '}
                {formatGiB(w.ram_available_bytes)} RAM
              </span>
              <div className="mosaic-inline-row">
                <span className={w.status === 'reachable' ? 'mosaic-badge mosaic-badge-success' : 'mosaic-badge mosaic-badge-error'}>
                  {w.status}{w.rtt_ms !== null ? ` (${w.rtt_ms} ms)` : ''}
                </span>
                <button
                  type="button"
                  className="mosaic-icon-btn mosaic-button-danger"
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
  );
}
