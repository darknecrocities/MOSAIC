import type { FitStatus } from '../../types/ipc';

export function FitBadge({ status }: { status: FitStatus }) {
  const className =
    status === 'Recommended'
      ? 'mosaic-badge mosaic-badge-success'
      : status === 'Borderline'
        ? 'mosaic-badge mosaic-badge-warn'
        : 'mosaic-badge mosaic-badge-error';

  return <span className={className}>{status}</span>;
}
