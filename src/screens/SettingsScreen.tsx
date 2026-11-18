import { useState } from 'react';
import { ClusterWorkersSection } from '../components/settings/ClusterWorkersSection';
import { DiagnosticsLogPanel } from '../components/settings/DiagnosticsLogPanel';
import type { AppSettingsSnapshot } from '../types/ipc';
import { toErrorMessage } from '../utils/tauriClient';

interface SettingsScreenProps {
  settings: AppSettingsSnapshot;
  onSaveSetting: (key: string, value: unknown) => Promise<void>;
}

export function SettingsScreen({ settings, onSaveSetting }: SettingsScreenProps) {
  const [reserve, setReserve] = useState(settings.safety_reserve_gib);
  const [endpoint, setEndpoint] = useState(settings.ollama_endpoint);
  const [profile, setProfile] = useState(settings.execution_profile);
  const [kvType, setKvType] = useState(settings.kv_cache_type);
  const [defaultCtx, setDefaultCtx] = useState(settings.default_context_length);
  const [maxModels, setMaxModels] = useState(settings.max_loaded_models);
  const [numParallel, setNumParallel] = useState(settings.num_parallel);
  const [keepAlive, setKeepAlive] = useState(settings.keep_alive);
  const [numBatch, setNumBatch] = useState(settings.num_batch != null ? String(settings.num_batch) : '');
  const [numUbatch, setNumUbatch] = useState(settings.num_ubatch != null ? String(settings.num_ubatch) : '');
  const [numThread, setNumThread] = useState(settings.num_thread != null ? String(settings.num_thread) : '');
  const [pollMs, setPollMs] = useState(settings.telemetry_poll_ms);
  const [mgmtMode, setMgmtMode] = useState(settings.ollama_management_mode);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const handleSave = async () => {
    setSavedNotice(null);
    setErrorNotice(null);
    try {
      const updates: Array<[string, unknown]> = [
        ['safety_reserve_gib', reserve],
        ['ollama_endpoint', endpoint],
        ['execution_profile', profile],
        ['kv_cache_type', kvType],
        ['default_context_length', defaultCtx],
        ['max_loaded_models', maxModels],
        ['num_parallel', numParallel],
        ['keep_alive', keepAlive],
        ['num_batch', numBatch.trim() ? Number(numBatch) : null],
        ['num_ubatch', numUbatch.trim() ? Number(numUbatch) : null],
        ['num_thread', numThread.trim() ? Number(numThread) : null],
        ['telemetry_poll_ms', pollMs],
        ['ollama_management_mode', mgmtMode],
      ];
      for (const [k, v] of updates) {
        await onSaveSetting(k, v);
      }
      setSavedNotice('Settings saved locally to SQLite.');
    } catch (err) {
      setErrorNotice(toErrorMessage(err));
    }
  };

  return (
    <div className="mosaic-stack">
      <div className="mosaic-settings-grid">
        <section className="mosaic-panel" aria-labelledby="settings-heading">
          <div className="mosaic-panel-header">
            <h2 id="settings-heading">Application &amp; Runtime Settings</h2>
          </div>

          <div className="mosaic-form-grid">
            <label className="mosaic-field">
              <span>OS Memory Safety Reserve (GiB)</span>
              <input type="number" min={0.5} max={64} step={0.5} className="mosaic-input" value={reserve} onChange={(e) => setReserve(Number(e.target.value))} />
            </label>
            <label className="mosaic-field">
              <span>Ollama Loopback Endpoint</span>
              <input type="url" className="mosaic-input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            </label>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Execution Profile</span>
                <select className="mosaic-input" value={profile} onChange={(e) => setProfile(e.target.value)}>
                  <option value="auto_adaptive">auto_adaptive</option>
                  <option value="max_quality">max_quality</option>
                  <option value="balanced">balanced</option>
                  <option value="constrained_memory">constrained_memory</option>
                </select>
              </label>
              <label className="mosaic-field">
                <span>KV Cache Type</span>
                <select className="mosaic-input" value={kvType} onChange={(e) => setKvType(e.target.value)}>
                  <option value="auto">auto</option>
                  <option value="f16">f16</option>
                  <option value="q8_0">q8_0</option>
                  <option value="q4_0">q4_0</option>
                </select>
              </label>
              <label className="mosaic-field">
                <span>Default Context Length</span>
                <input type="number" min={512} max={131072} step={512} className="mosaic-input" value={defaultCtx} onChange={(e) => setDefaultCtx(Number(e.target.value))} />
              </label>
            </div>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Max Loaded Models</span>
                <input type="number" min={1} max={8} className="mosaic-input" value={maxModels} onChange={(e) => setMaxModels(Number(e.target.value))} />
              </label>
              <label className="mosaic-field">
                <span>Num Parallel</span>
                <input type="number" min={1} max={8} className="mosaic-input" value={numParallel} onChange={(e) => setNumParallel(Number(e.target.value))} />
              </label>
              <label className="mosaic-field">
                <span>Keep Alive</span>
                <input type="text" className="mosaic-input" value={keepAlive} onChange={(e) => setKeepAlive(e.target.value)} />
              </label>
            </div>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Batch (optional)</span>
                <input type="number" min={1} max={8192} className="mosaic-input" placeholder="Auto" value={numBatch} onChange={(e) => setNumBatch(e.target.value)} />
              </label>
              <label className="mosaic-field">
                <span>UBatch (optional)</span>
                <input type="number" min={1} max={8192} className="mosaic-input" placeholder="Auto" value={numUbatch} onChange={(e) => setNumUbatch(e.target.value)} />
              </label>
              <label className="mosaic-field">
                <span>Threads (optional)</span>
                <input type="number" min={1} max={1024} className="mosaic-input" placeholder="Auto" value={numThread} onChange={(e) => setNumThread(e.target.value)} />
              </label>
            </div>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Telemetry Poll (ms)</span>
                <input type="number" min={500} max={30000} step={500} className="mosaic-input" value={pollMs} onChange={(e) => setPollMs(Number(e.target.value))} />
              </label>
              <label className="mosaic-field">
                <span>Ollama Management</span>
                <select className="mosaic-input" value={mgmtMode} onChange={(e) => setMgmtMode(e.target.value)}>
                  <option value="managed_or_detected">managed_or_detected</option>
                  <option value="managed_only">managed_only</option>
                  <option value="external_only">external_only</option>
                </select>
              </label>
            </div>
            <div className="mosaic-card-actions">
              <button type="button" className="mosaic-button" onClick={() => void handleSave()}>
                Save Settings
              </button>
            </div>
            {savedNotice && <p role="status" className="mosaic-callout mosaic-callout-success">{savedNotice}</p>}
            {errorNotice && <p role="status" className="mosaic-callout mosaic-callout-error">{errorNotice}</p>}
          </div>
        </section>

        <DiagnosticsLogPanel />
      </div>

      <ClusterWorkersSection />
    </div>
  );
}
