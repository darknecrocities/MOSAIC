import { X } from 'lucide-react';
import type { CatalogModelWithFit } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { FitBadge } from './FitBadge';

interface ModelDetailDrawerProps {
  item: CatalogModelWithFit | null;
  onClose: () => void;
}

export function ModelDetailDrawer({ item, onClose }: ModelDetailDrawerProps) {
  if (!item) return null;
  const { model, fit } = item;

  return (
    <div
      className="mosaic-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-drawer-title"
    >
      <div className="mosaic-modal">
        <div className="mosaic-panel-header">
          <div>
            <h2 id="detail-drawer-title">{model.display_name}</h2>
            <span className="mosaic-subtitle">
              <code>{model.ollama_name}</code>
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
      </div>
    </div>
  );
}
