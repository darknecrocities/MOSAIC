import { useEffect, useState } from 'react';
import { Layers, X } from 'lucide-react';
import type { CatalogModelWithFit, ClusterPlan } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { ClusterPlanPanel } from '../cluster/ClusterPlanPanel';
import { FitBadge } from './FitBadge';

interface ModelDetailDrawerProps {
  item: CatalogModelWithFit | null;
  onClose: () => void;
}

export function ModelDetailDrawer({ item, onClose }: ModelDetailDrawerProps) {
  const [clusterPlan, setClusterPlan] = useState<ClusterPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    setClusterPlan(null);
    setPlanError(null);
  }, [item?.model.ollama_name]);

  if (!item) return null;
  const { model, fit } = item;

  const handleComputePlan = async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const plan = await invoke<ClusterPlan>('plan_adaptive_execution', {
        ollamaName: model.ollama_name,
        contextLength: fit.context_length,
      });
      setClusterPlan(plan);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Cluster planner requires Tauri runtime.');
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div
      className="mosaic-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-drawer-title"
    >
      <div className="mosaic-modal" style={{ maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="mosaic-panel-header">
          <div>
            <h2 id="detail-drawer-title">{model.display_name}</h2>
            <span className="mosaic-subtitle">
              <code>{model.ollama_name}</code>
              {model.is_moe && model.active_parameter_billions
                ? ` · MoE (${model.active_parameter_billions}B active / ${model.parameter_billions}B total)`
                : ''}
            </span>
          </div>
          <button
            type="button"
            className="mosaic-button-secondary"
            onClick={onClose}
            aria-label="Close model details"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <FitBadge status={fit.fit_status} />{' '}
          <span className="mosaic-badge">
            {fit.source} · {fit.confidence} confidence
          </span>
        </div>

        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Weight Memory</span>
          <span>
            {fit.weight_memory_estimate ? formatGiB(fit.weight_memory_estimate) : 'Unknown'}
          </span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">KV Cache ({fit.context_length} ctx)</span>
          <span>{fit.kv_cache_estimate ? formatGiB(fit.kv_cache_estimate) : 'Unknown'}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Runtime Overhead</span>
          <span>
            {fit.runtime_overhead_estimate ? formatGiB(fit.runtime_overhead_estimate) : 'Unknown'}
          </span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Safe Memory Budget</span>
          <span>{fit.available_budget ? formatGiB(fit.available_budget) : 'Unknown'}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Expected Backend</span>
          <span>{fit.expected_backend}</span>
        </div>
        <div className="mosaic-kv">
          <span className="mosaic-kv-label">Speed Estimate</span>
          <span>{fit.performance_estimate}</span>
        </div>

        <ul style={{ paddingLeft: 18, marginTop: 12 }}>
          {fit.reasons.map((reason) => (
            <li key={reason} className="mosaic-subtitle">
              {reason}
            </li>
          ))}
        </ul>

        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="mosaic-button-secondary"
            disabled={planning}
            onClick={() => void handleComputePlan()}
          >
            <Layers size={15} aria-hidden="true" />
            <span>{planning ? 'Computing Plan...' : 'Compute Adaptive / Cluster Plan'}</span>
          </button>
        </div>

        {planError && (
          <p className="mosaic-subtitle" style={{ marginTop: 8 }}>
            {planError}
          </p>
        )}
        {clusterPlan && <ClusterPlanPanel plan={clusterPlan} />}
      </div>
    </div>
  );
}
