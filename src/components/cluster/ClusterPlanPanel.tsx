import { Layers, Network } from 'lucide-react';
import type { ClusterPlan } from '../../types/ipc';
import { formatGiB } from '../../utils/format';

export function ClusterPlanPanel({ plan }: { plan: ClusterPlan }) {
  return (
    <section className="mosaic-panel" aria-labelledby="cluster-plan-heading" style={{ marginTop: 12 }}>
      <div className="mosaic-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Layers size={15} color="#2878B8" aria-hidden="true" />
          <h3 id="cluster-plan-heading">Adaptive Memory &amp; Cluster Plan</h3>
        </div>
        <span className={plan.feasible ? 'mosaic-badge mosaic-badge-success' : 'mosaic-badge mosaic-badge-warn'}>
          {plan.strategy}
        </span>
      </div>

      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Tier 1 (GPU / Unified Metal)</span>
        <span>{formatGiB(plan.tier1_gpu_bytes)}</span>
      </div>
      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Tier 2 (System RAM / MoE Experts)</span>
        <span>{formatGiB(plan.tier2_ram_bytes)}</span>
      </div>
      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Tier 3 (External Drive mmap)</span>
        <span>{formatGiB(plan.tier3_disk_mmap_bytes)}</span>
      </div>

      {plan.node_allocations.length > 1 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Network size={14} color="#2878B8" aria-hidden="true" />
            <strong>Pooled RPC Nodes</strong>
          </div>
          {plan.node_allocations.map((n) => (
            <div key={`${n.name}-${n.endpoint}`} className="mosaic-kv">
              <span className="mosaic-kv-label">
                {n.name} ({n.role})
              </span>
              <span>{formatGiB(n.allocated_bytes)}</span>
            </div>
          ))}
        </div>
      )}

      {plan.runtime_flags.length > 0 && (
        <p className="mosaic-subtitle" style={{ marginTop: 8 }}>
          Flags: <code>{plan.runtime_flags.join(' ')}</code>
        </p>
      )}

      {plan.warnings.length > 0 && (
        <ul style={{ paddingLeft: 18, marginTop: 8, marginBottom: 0 }}>
          {plan.warnings.map((w) => (
            <li key={w} className="mosaic-subtitle">
              {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
