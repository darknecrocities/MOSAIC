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
        <HardDrive size={18} color="#2878B8" aria-hidden="true" />
      </div>
      <p className="mosaic-subtitle">
        MOSAIC requires a dedicated external HDD or SSD for storing Ollama model weights under{' '}
        <code>MOSAIC/ollama-models</code>. Internal disk fallback is disabled so your main
        system drive is never filled silently.
      </p>

      {volumes.length === 0 ? (
        <div className="mosaic-panel-white" role="status" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} color="#B7791F" aria-hidden="true" />
            <strong>No eligible external drive detected</strong>
          </div>
          <p className="mosaic-subtitle" style={{ marginBottom: 12 }}>
            Connect an external SSD (recommended) or HDD via USB/Thunderbolt, then click Rescan.
            You can still inspect your machine&apos;s hardware profile while disconnected.
          </p>
          <button type="button" className="mosaic-button-secondary" onClick={onInspectHardware}>
            Inspect Hardware Profile
          </button>
        </div>
      ) : (
        <div className="mosaic-grid" style={{ marginTop: 12 }}>
          {volumes.map((vol) => (
            <div key={vol.volume_identifier} className="mosaic-panel-white">
              <div className="mosaic-panel-header">
                <h3>{vol.label}</h3>
                <span className="mosaic-badge">{vol.media_kind}</span>
              </div>
              <div className="mosaic-kv">
                <span className="mosaic-kv-label">Filesystem</span>
                <span>{vol.filesystem}</span>
              </div>
              <div className="mosaic-kv">
                <span className="mosaic-kv-label">Free / Total</span>
                <span>
                  {formatGiB(vol.free_bytes)} / {formatGiB(vol.total_bytes)}
                </span>
              </div>
              {vol.advisory && <p className="mosaic-subtitle">{vol.advisory}</p>}
              <button
                type="button"
                className="mosaic-button"
                style={{ width: '100%', marginTop: 8 }}
                disabled={!vol.writable || selecting}
                onClick={() => onSelectVolume(vol.volume_identifier)}
              >
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>{selecting ? 'Validating...' : 'Use as MOSAIC Library'}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
