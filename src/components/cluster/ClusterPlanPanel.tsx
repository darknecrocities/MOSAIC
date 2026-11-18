import { useState } from 'react';
import { Layers, Network, Play, Square } from 'lucide-react';
import type { ClusterPlan } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { mosaicApi } from '../../utils/mosaicApi';
import { toErrorMessage } from '../../utils/tauriClient';
import { ConfirmModal } from '../common/ConfirmModal';

function validateGgufRelPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return 'GGUF path must be relative to the external library (no leading slash).';
  }
  const segments = trimmed.split(/[/\\]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) {
    return 'GGUF path cannot contain "." or ".." traversal segments.';
  }
  if (segments.some((s) => s.startsWith('.') || s.startsWith('._'))) {
    return 'GGUF path cannot include hidden or AppleDouble (._) components.';
  }
  const fileName = segments[segments.length - 1] ?? '';
  if (!fileName.toLowerCase().endsWith('.gguf') || fileName.length <= 5) {
    return 'GGUF path must end with a non-empty .gguf filename (e.g. models/model.gguf).';
  }
  return null;
}

export function ClusterPlanPanel({ plan }: { plan: ClusterPlan }) {
  const [ggufRelPath, setGgufRelPath] = useState('');
  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState(false);
  const [busy, setBusy] = useState(false);

  const ggufWarning = validateGgufRelPath(ggufRelPath);

  const handleLaunch = async () => {
    setBusy(true);
    setRuntimeNotice(null);
    setRuntimeError(false);
    try {
      const msg = await mosaicApi.launchClusterRuntime(ggufRelPath.trim(), plan.runtime_flags, true);
      setRuntimeNotice(msg);
    } catch (err) {
      setRuntimeError(true);
      setRuntimeNotice(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setRuntimeNotice(null);
    setRuntimeError(false);
    try {
      const stopped = await mosaicApi.stopClusterRuntime();
      setRuntimeNotice(stopped ? 'Cluster runtime stopped.' : 'No active cluster runtime.');
    } catch (err) {
      setRuntimeError(true);
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
            disabled={!ggufRelPath.trim() || busy}
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
        {ggufWarning && <p className="mosaic-callout mosaic-callout-warn" role="alert">{ggufWarning}</p>}
        {runtimeNotice && (
          <p className={runtimeError ? 'mosaic-callout mosaic-callout-error' : 'mosaic-callout mosaic-callout-info'} role="status">
            {runtimeNotice}
          </p>
        )}
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
