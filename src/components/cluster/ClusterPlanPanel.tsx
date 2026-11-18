import { useState } from 'react';
import { Layers, Network, Play, Square } from 'lucide-react';
import type { ClusterPlan } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { mosaicApi } from '../../utils/mosaicApi';
import { toErrorMessage } from '../../utils/tauriClient';
import { ConfirmModal } from '../common/ConfirmModal';

export function ClusterPlanPanel({ plan }: { plan: ClusterPlan }) {
  const [ggufRelPath, setGgufRelPath] = useState('');
  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const validGguf = ggufRelPath.trim().toLowerCase().endsWith('.gguf');

  const handleLaunch = async () => {
    setBusy(true);
    setRuntimeNotice(null);
    try {
      const msg = await mosaicApi.launchClusterRuntime(ggufRelPath.trim(), plan.runtime_flags, true);
      setRuntimeNotice(msg);
    } catch (err) {
      setRuntimeNotice(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setRuntimeNotice(null);
    try {
      const stopped = await mosaicApi.stopClusterRuntime();
      setRuntimeNotice(stopped ? 'Cluster runtime stopped.' : 'No active cluster runtime.');
    } catch (err) {
      setRuntimeNotice(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mosaic-panel mosaic-stack-sm" aria-labelledby="cluster-plan-heading">
      <div className="mosaic-panel-header">
        <div className="mosaic-inline-row">
          <Layers size={15} className="mosaic-icon-accent" aria-hidden="true" />
          <h3 id="cluster-plan-heading">Adaptive Memory &amp; Cluster Plan</h3>
        </div>
        <span className={plan.feasible ? 'mosaic-badge mosaic-badge-success' : 'mosaic-badge mosaic-badge-warn'}>
          {plan.strategy}
        </span>
      </div>

      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Tier 1 (GPU / Unified Metal)</span>
        <span className="mosaic-num">{formatGiB(plan.tier1_gpu_bytes)}</span>
      </div>
      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Tier 2 (System RAM / MoE Experts)</span>
        <span className="mosaic-num">{formatGiB(plan.tier2_ram_bytes)}</span>
      </div>
      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Tier 3 (External Drive mmap)</span>
        <span className="mosaic-num">{formatGiB(plan.tier3_disk_mmap_bytes)}</span>
      </div>

      {plan.node_allocations.length > 1 && (
        <div className="mosaic-stack-sm">
          <div className="mosaic-inline-row">
            <Network size={14} className="mosaic-icon-accent" aria-hidden="true" />
            <strong>Pooled RPC Nodes</strong>
          </div>
          {plan.node_allocations.map((n) => (
            <div key={`${n.name}-${n.endpoint}`} className="mosaic-kv">
              <span className="mosaic-kv-label">{n.name} ({n.role})</span>
              <span className="mosaic-num">{formatGiB(n.allocated_bytes)}</span>
            </div>
          ))}
        </div>
      )}

      {plan.runtime_flags.length > 0 && (
        <p className="mosaic-subtitle">
          Flags: <code>{plan.runtime_flags.join(' ')}</code>
        </p>
      )}

      {plan.warnings.length > 0 && (
        <ul className="mosaic-list">
          {plan.warnings.map((w) => (
            <li key={w} className="mosaic-subtitle">{w}</li>
          ))}
        </ul>
      )}

      <div className="mosaic-stack-sm">
        <label className="mosaic-field">
          <span>GGUF Relative Path (Phase 7 llama-server)</span>
          <input
            type="text"
            className="mosaic-input"
            aria-label="GGUF relative path"
            placeholder="models/qwen3-30b.gguf"
            value={ggufRelPath}
            onChange={(e) => setGgufRelPath(e.target.value)}
          />
        </label>
        <div className="mosaic-card-actions">
          <button
            type="button"
            className="mosaic-button"
            disabled={!validGguf || busy}
            onClick={() => setConfirmLaunch(true)}
          >
            <Play size={14} aria-hidden="true" />
            <span>Launch Cluster Runtime</span>
          </button>
          <button
            type="button"
            className="mosaic-button-danger"
            disabled={busy}
            onClick={() => void handleStop()}
          >
            <Square size={14} aria-hidden="true" />
            <span>Stop Cluster Runtime</span>
          </button>
        </div>
        {runtimeNotice && <p className="mosaic-callout mosaic-callout-info" role="status">{runtimeNotice}</p>}
      </div>

      <ConfirmModal
        open={confirmLaunch}
        title="Launch Experimental Cluster Runtime"
        description={`Start llama-server with ${ggufRelPath.trim()} and ${plan.runtime_flags.length} allowlisted flag(s)?`}
        confirmLabel="Launch Runtime"
        onCancel={() => setConfirmLaunch(false)}
        onConfirm={() => {
          setConfirmLaunch(false);
          void handleLaunch();
        }}
      />
    </section>
  );
}
