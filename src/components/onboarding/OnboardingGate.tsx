import { AlertTriangle, CheckCircle2, HardDrive } from 'lucide-react';
import type { ExternalVolume } from '../../types/ipc';
import { formatGiB } from '../../utils/format';

interface OnboardingGateProps {
  volumes: ExternalVolume[];
  selecting: boolean;
  onSelectVolume: (volumeId: string) => void;
  onInspectHardware: () => void;
}

export function OnboardingGate({
  volumes,
  selecting,
  onSelectVolume,
  onInspectHardware,
}: OnboardingGateProps) {
  return (
    <section className="mosaic-panel" aria-labelledby="onboarding-heading">
      <div className="mosaic-panel-header">
        <h2 id="onboarding-heading">Connect &amp; Select Your External Model Library</h2>
        <HardDrive size={18} className="mosaic-icon-accent" aria-hidden="true" />
      </div>
      <p className="mosaic-subtitle">
        MOSAIC requires a dedicated external HDD or SSD for storing Ollama model weights under{' '}
        <code>MOSAIC/ollama-models</code>. Internal disk fallback is disabled so your main
        system drive is never filled silently.
      </p>

      {volumes.length === 0 ? (
        <div className="mosaic-panel-white mosaic-stack-sm" role="status">
          <div className="mosaic-inline-row">
            <AlertTriangle size={16} className="mosaic-icon-warn" aria-hidden="true" />
            <strong>No eligible external drive detected</strong>
          </div>
          <p className="mosaic-subtitle">
            Connect an external SSD (recommended) or HDD via USB/Thunderbolt, then click Rescan.
            You can still inspect your machine&apos;s hardware profile while disconnected.
          </p>
          <div className="mosaic-card-actions">
            <button type="button" className="mosaic-button-secondary" onClick={onInspectHardware}>
              Inspect Hardware Profile
            </button>
          </div>
        </div>
      ) : (
        <div className="mosaic-grid mosaic-stack-sm">
          {volumes.map((vol) => (
            <div key={vol.volume_identifier} className="mosaic-panel-white">
              <div className="mosaic-panel-header">
                <h3>{vol.label}</h3>
                <span className="mosaic-subtitle">
                  {vol.media_kind} · {vol.filesystem}
                </span>
              </div>
              <div className="mosaic-kv">
                <span className="mosaic-kv-label">Filesystem</span>
                <span>{vol.filesystem}</span>
              </div>
              <div className="mosaic-kv">
                <span className="mosaic-kv-label">Free / Total</span>
                <span className="mosaic-num">
                  {formatGiB(vol.free_bytes)} / {formatGiB(vol.total_bytes)}
                </span>
              </div>
              {vol.advisory && <p className="mosaic-callout mosaic-callout-warn">{vol.advisory}</p>}
              <div className="mosaic-card-actions">
                <button
                  type="button"
                  className="mosaic-button"
                  disabled={!vol.writable || selecting}
                  onClick={() => onSelectVolume(vol.volume_identifier)}
                >
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>{selecting ? 'Validating...' : 'Use Library'}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
