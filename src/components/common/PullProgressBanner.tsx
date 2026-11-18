import { XCircle } from 'lucide-react';
import type { PullProgressEvent } from '../../types/ipc';
import { formatProgressBytes } from '../../utils/format';

interface PullProgressBannerProps {
  pullProgress: PullProgressEvent;
  onCancelPull: (model: string) => void;
}

export function PullProgressBanner({ pullProgress, onCancelPull }: PullProgressBannerProps) {
  const hasTotal = pullProgress.total != null && pullProgress.total > 0;
  const completed = pullProgress.completed ?? 0;
  const total = pullProgress.total ?? 1;

  return (
    <section className="mosaic-panel" role="status" aria-live="polite" aria-label="Model download progress">
      <div className="mosaic-panel-header">
        <div>
          <strong>Pulling {pullProgress.model}</strong>
          <p className="mosaic-subtitle">
            {pullProgress.status} · {formatProgressBytes(pullProgress.completed, pullProgress.total)}
          </p>
        </div>
        <button
          type="button"
          className="mosaic-button-danger"
          onClick={() => onCancelPull(pullProgress.model)}
        >
          <XCircle size={15} aria-hidden="true" />
          <span>Cancel Pull</span>
        </button>
      </div>
      {hasTotal ? (
        <progress
          className="mosaic-progress"
          value={completed}
          max={total}
          aria-label={`Download progress for ${pullProgress.model}`}
        />
      ) : (
        <progress
          className="mosaic-progress"
          aria-label={`Download progress for ${pullProgress.model}`}
        />
      )}
    </section>
  );
}
