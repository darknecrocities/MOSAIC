import { X } from 'lucide-react';
import type { ModelShowDetails } from '../../types/ipc';

interface ModelShowModalProps {
  open: boolean;
  modelName: string | null;
  loading: boolean;
  error: string | null;
  details: ModelShowDetails | null;
  onClose: () => void;
}

export function ModelShowModal({
  open,
  modelName,
  loading,
  error,
  details,
  onClose,
}: ModelShowModalProps) {
  if (!open) return null;

  return (
    <div
      className="mosaic-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-show-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="mosaic-modal">
        <div className="mosaic-panel-header">
          <h2 id="model-show-title">Model Metadata: {modelName ?? ''}</h2>
          <button
            type="button"
            className="mosaic-icon-btn"
            onClick={onClose}
            aria-label="Close model metadata"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {loading && <p className="mosaic-subtitle">Loading /api/show metadata...</p>}
        {error && <p className="mosaic-callout mosaic-callout-error">{error}</p>}

        {details && (
          <div className="mosaic-stack-sm">
            {details.details && (
              <>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Family / Format</span>
                  <span>{details.details.family ?? 'n/a'} · {details.details.format ?? 'n/a'}</span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Parameters / Quant</span>
                  <span className="mosaic-num">
                    {details.details.parameter_size ?? 'n/a'} · {details.details.quantization_level ?? 'n/a'}
                  </span>
                </div>
              </>
            )}
            {details.capabilities && details.capabilities.length > 0 && (
              <div className="mosaic-kv">
                <span className="mosaic-kv-label">Capabilities</span>
                <span>{details.capabilities.join(', ')}</span>
              </div>
            )}
            {details.parameters && (
              <div>
                <span className="mosaic-eyebrow">Parameters</span>
                <pre>{details.parameters}</pre>
              </div>
            )}
            {details.template && (
              <div>
                <span className="mosaic-eyebrow">Template</span>
                <pre>{details.template}</pre>
              </div>
            )}
            {details.modelfile && (
              <div>
                <span className="mosaic-eyebrow">Modelfile</span>
                <pre>{details.modelfile}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
