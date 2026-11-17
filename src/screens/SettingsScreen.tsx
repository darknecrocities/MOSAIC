import { useState } from 'react';
import type { AppSettingsSnapshot } from '../types/ipc';

interface SettingsScreenProps {
  settings: AppSettingsSnapshot;
  onSaveSetting: (key: string, value: unknown) => Promise<void>;
}

export function SettingsScreen({ settings, onSaveSetting }: SettingsScreenProps) {
  const [reserve, setReserve] = useState<number>(settings.safety_reserve_gib);
  const [endpoint, setEndpoint] = useState<string>(settings.ollama_endpoint);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const handleSave = async () => {
    setSavedNotice(null);
    await onSaveSetting('safety_reserve_gib', reserve);
    await onSaveSetting('ollama_endpoint', endpoint);
    setSavedNotice('Settings saved locally to SQLite.');
  };

  return (
    <section className="mosaic-panel" aria-labelledby="settings-heading">
      <div className="mosaic-panel-header">
        <h2 id="settings-heading">Application &amp; Runtime Settings</h2>
        <span className="mosaic-badge">Local-first</span>
      </div>

      <div style={{ display: 'grid', gap: 16, maxWidth: 520 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>OS Memory Safety Reserve (GiB)</span>
          <input
            type="number"
            min={0.5}
            max={16}
            step={0.5}
            className="mosaic-input"
            value={reserve}
            onChange={(e) => setReserve(Number(e.target.value))}
          />
          <span className="mosaic-subtitle">
            Reserved for macOS/Windows/Linux and foreground apps before recommending models.
          </span>
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span>Ollama Loopback Endpoint</span>
          <input
            type="url"
            className="mosaic-input"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <span className="mosaic-subtitle">
            Must remain loopback (<code>127.0.0.1</code> or <code>localhost</code>) by default.
          </span>
        </label>

        <div>
          <button type="button" className="mosaic-button" onClick={() => void handleSave()}>
            Save Settings
          </button>
        </div>

        {savedNotice && (
          <p role="status" className="mosaic-badge mosaic-badge-success">
            {savedNotice}
          </p>
        )}
      </div>
    </section>
  );
}
