import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Layers, X } from 'lucide-react';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';
import type { CatalogModelWithFit, ClusterPlan } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { mosaicApi } from '../../utils/mosaicApi';
import { toErrorMessage } from '../../utils/tauriClient';
import { ClusterPlanPanel } from '../cluster/ClusterPlanPanel';
import { ConfirmModal } from '../common/ConfirmModal';
import { FitBadge } from './FitBadge';

interface ModelDetailDrawerProps {
  item: CatalogModelWithFit | null;
  libraryConnected?: boolean;
  freeBytes?: number;
  pullingName?: string | null;
  onPullModel?: (ollamaName: string) => void;
  onClose: () => void;
}

export function ModelDetailDrawer({
  item,
  libraryConnected = false,
  freeBytes = 0,
  pullingName = null,
  onPullModel,
  onClose,
}: ModelDetailDrawerProps) {
  const [clusterPlan, setClusterPlan] = useState<ClusterPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirmAdaptivePull, setConfirmAdaptivePull] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const planReqIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    planReqIdRef.current += 1;
    setClusterPlan(null);
    setPlanning(false);
    setPlanError(null);
    setConfirmAdaptivePull(false);
  }, [item?.model.ollama_name]);

  useDialogAccessibility({ open: Boolean(item), dialogRef: drawerRef, onClose });

  if (!item) return null;
  const { model, fit } = item;
  const enoughSpace = freeBytes >= model.download_size_bytes * 1.1;
  const isPulling = pullingName === model.ollama_name;
  const plan = fit.execution_plan;
  const formatOptGiB = (val: number | null | undefined) =>
    typeof val === 'number' && Number.isFinite(val) ? formatGiB(val) : 'Unknown';

  const handleComputePlan = async () => {
    const reqId = ++planReqIdRef.current;
    setPlanning(true);
    setPlanError(null);
    try {
      const nextPlan = await mosaicApi.planAdaptiveExecution(model.ollama_name, fit.context_length);
      if (mountedRef.current && planReqIdRef.current === reqId) {
        setClusterPlan(nextPlan);
      }
    } catch (err) {
      if (mountedRef.current && planReqIdRef.current === reqId) {
        setPlanError(toErrorMessage(err, 'Cluster planner requires Tauri runtime.'));
      }
    } finally {
      if (mountedRef.current && planReqIdRef.current === reqId) {
        setPlanning(false);
      }
    }
  };

  const drawer = (
    <div
      className="mosaic-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-drawer-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={drawerRef} tabIndex={-1} className="mosaic-drawer">
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
            className="mosaic-icon-btn"
            onClick={onClose}
            aria-label="Close model details"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="mosaic-inline-row">
          <FitBadge status={fit.fit_status} />
          <span className="mosaic-subtitle">
            Confidence: {fit.confidence} ({fit.source})
          </span>
        </div>

        <div className="mosaic-stack-sm">
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Weight Memory</span>
            <span className="mosaic-num">{formatOptGiB(fit.weight_memory_estimate)}</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">KV Cache ({fit.context_length} ctx)</span>
            <span className="mosaic-num">{formatOptGiB(fit.kv_cache_estimate)}</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Runtime Overhead</span>
            <span className="mosaic-num">{formatOptGiB(fit.runtime_overhead_estimate)}</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Safe Memory Budget</span>
            <span className="mosaic-num">{formatOptGiB(fit.available_budget)}</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Expected Backend</span>
            <span>{fit.expected_backend}</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Speed Estimate</span>
            <span>{fit.performance_estimate}</span>
          </div>
        </div>

        {plan && (
          <section className="mosaic-panel mosaic-stack-sm" aria-label="Adaptive execution plan">
            <h3>Adaptive Execution Plan ({plan.profile})</h3>
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">Context / KV Cache</span>
              <span className="mosaic-num">{plan.num_ctx} ctx · {plan.kv_cache_type.toUpperCase()}</span>
            </div>
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">GPU Offload / Layers</span>
              <span className="mosaic-num">
                {Math.round(plan.offload_ratio * 100)}% ({plan.num_gpu < 0 ? 'Auto' : `${plan.num_gpu} layers`})
              </span>
            </div>
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">Batch / Threads</span>
              <span className="mosaic-num">
                {plan.num_batch}/{plan.num_ubatch} · {plan.num_thread}T
              </span>
            </div>
            {plan.warnings.length > 0 && (
              <ul className="mosaic-list">
                {plan.warnings.map((w, idx) => (
                  <li key={`${w}-${idx}`} className="mosaic-subtitle">{w}</li>
                ))}
              </ul>
            )}
          </section>
        )}

        <ul className="mosaic-list">
          {fit.reasons.map((reason, idx) => (
            <li key={`${reason}-${idx}`} className="mosaic-subtitle">{reason}</li>
          ))}
          {(fit.limitations ?? []).map((lim, idx) => (
            <li key={`${lim}-${idx}`} className="mosaic-subtitle">{lim}</li>
          ))}
        </ul>

        <div className="mosaic-card-actions">
          <button
            type="button"
            className="mosaic-button-secondary"
            disabled={planning}
            onClick={() => void handleComputePlan()}
          >
            <Layers size={15} aria-hidden="true" />
            <span>{planning ? 'Computing Plan...' : 'Compute Adaptive / Cluster Plan'}</span>
          </button>
          {onPullModel && fit.fit_status === 'Not recommended' && (
            <button
              type="button"
              className="mosaic-button-secondary"
              disabled={!libraryConnected || !enoughSpace || isPulling}
              onClick={() => setConfirmAdaptivePull(true)}
            >
              <Download size={15} aria-hidden="true" />
              <span>{isPulling ? 'Pulling...' : 'Adaptive Pull...'}</span>
            </button>
          )}
        </div>

        {planError && <p className="mosaic-callout mosaic-callout-error">{planError}</p>}
        {clusterPlan && <ClusterPlanPanel plan={clusterPlan} />}

        <ConfirmModal
          open={confirmAdaptivePull}
          title="Pull Exceeds Safe Memory Budget"
          description={`${model.display_name} (${formatGiB(model.download_size_bytes)}) is rated Not recommended for single-node safe memory. Proceed to download weights to your external library for CPU spill, mmap, or GGML_RPC cluster execution?`}
          confirmLabel="Download Anyway"
          onCancel={() => setConfirmAdaptivePull(false)}
          onConfirm={() => {
            setConfirmAdaptivePull(false);
            onPullModel?.(model.ollama_name);
          }}
        />
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(drawer, document.body) : drawer;
}
