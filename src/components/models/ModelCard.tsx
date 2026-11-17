import { Download, ExternalLink, Info } from 'lucide-react';
import type { CatalogModelWithFit } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { FitBadge } from './FitBadge';

interface ModelCardProps {
  item: CatalogModelWithFit;
  libraryConnected: boolean;
  freeBytes: number;
  pullingName: string | null;
  onViewDetails: (item: CatalogModelWithFit) => void;
  onPullModel?: (ollamaName: string) => void;
}

export function ModelCard({
  item,
  libraryConnected,
  freeBytes,
  pullingName,
  onViewDetails,
  onPullModel,
}: ModelCardProps) {
  const { model, fit } = item;
  const enoughSpace = freeBytes >= model.download_size_bytes * 1.1;
  const isNotRecommended = fit.fit_status === 'Not recommended';
  const canDownload = libraryConnected && enoughSpace && !isNotRecommended && Boolean(onPullModel);
  const isPulling = pullingName === model.ollama_name;

  return (
    <article className="mosaic-panel-white" aria-label={model.display_name}>
      <div className="mosaic-panel-header">
        <div>
          <h3>{model.display_name}</h3>
          <span className="mosaic-subtitle">
            {model.provider} · {model.parameter_billions}B · {model.quantization}
          </span>
        </div>
        <FitBadge status={fit.fit_status} />
      </div>

      <p className="mosaic-subtitle" style={{ marginTop: 4 }}>
        {model.summary}
      </p>

      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Download Size</span>
        <span>{formatGiB(model.download_size_bytes)}</span>
      </div>
      <div className="mosaic-kv">
        <span className="mosaic-kv-label">Est. Runtime Memory</span>
        <span>
          {fit.total_estimated_bytes ? formatGiB(fit.total_estimated_bytes) : 'Unknown'}
        </span>
      </div>
      <div className="mosaic-kv">
        <span className="mosaic-kv-label">License</span>
        <a href={model.license_url} target="_blank" rel="noreferrer">
          {model.license_name} <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>

      {fit.reasons[0] && (
        <p className="mosaic-subtitle" style={{ marginTop: 8 }}>
          {fit.reasons[0]}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="mosaic-button-secondary"
          style={{ flex: 1 }}
          onClick={() => onViewDetails(item)}
        >
          <Info size={15} aria-hidden="true" />
          <span>View details</span>
        </button>

        {!isNotRecommended && (
          <button
            type="button"
            className="mosaic-button"
            style={{ flex: 1 }}
            disabled={!canDownload || isPulling}
            onClick={() => onPullModel?.(model.ollama_name)}
            title={
              !libraryConnected
                ? 'Connect an external drive to download models'
                : !enoughSpace
                  ? 'Insufficient free space on external drive'
                  : `Pull ${model.ollama_name}`
            }
          >
            <Download size={15} aria-hidden="true" />
            <span>{isPulling ? 'Pulling...' : 'Download'}</span>
          </button>
        )}
      </div>
    </article>
  );
}
