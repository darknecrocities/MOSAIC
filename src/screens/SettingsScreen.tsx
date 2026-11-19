import { useEffect, useRef, useState } from 'react';
import { ClusterWorkersSection } from '../components/settings/ClusterWorkersSection';
import { DiagnosticsLogPanel } from '../components/settings/DiagnosticsLogPanel';
import type { AppSettingsSnapshot } from '../types/ipc';
import { toErrorMessage } from '../utils/tauriClient';

interface SettingsScreenProps {
  settings: AppSettingsSnapshot;
  onSaveSetting: (key: string, value: unknown) => Promise<void>;
}

type SettingsDraft = {
  reserve: string;
  endpoint: string;
  profile: string;
  kvType: string;
  defaultCtx: string;
  maxModels: string;
  numParallel: string;
  keepAlive: string;
  numBatch: string;
  numUbatch: string;
  numThread: string;
  pollMs: string;
  mgmtMode: string;
};

function snapshotToDraft(s: AppSettingsSnapshot): SettingsDraft {
  return {
    reserve: String(s.safety_reserve_gib),
    endpoint: s.ollama_endpoint,
    profile: s.execution_profile,
    kvType: s.kv_cache_type,
    defaultCtx: String(s.default_context_length),
    maxModels: String(s.max_loaded_models),
    numParallel: String(s.num_parallel),
    keepAlive: s.keep_alive,
    numBatch: s.num_batch != null ? String(s.num_batch) : '',
    numUbatch: s.num_ubatch != null ? String(s.num_ubatch) : '',
    numThread: s.num_thread != null ? String(s.num_thread) : '',
    pollMs: String(s.telemetry_poll_ms),
    mgmtMode: s.ollama_management_mode,
  };
}

function parseNumericInput(raw: string, label: string): number {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid number.`);
  return parsed;
}

export function SettingsScreen({ settings, onSaveSetting }: SettingsScreenProps) {
  const [draft, setDraft] = useState<SettingsDraft>(() => snapshotToDraft(settings));
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const savingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const syncedDraftRef = useRef<SettingsDraft>(snapshotToDraft(settings));
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;

  const setField = (field: keyof SettingsDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    if (savingRef.current) return;
    const prevSynced = syncedDraftRef.current;
    const nextSynced = snapshotToDraft(settings);
    const curr = draftRef.current;
    const updated = { ...curr };
    for (const k of Object.keys(nextSynced) as Array<keyof SettingsDraft>) {
      if (curr[k] === prevSynced[k]) updated[k] = nextSynced[k];
    }
    syncedDraftRef.current = nextSynced;
    setDraft(updated);
  }, [settings]);

  const handleSave = async () => {
    if (savingRef.current) return;
    setSavedNotice(null);
    setErrorNotice(null);
    const startSettings = latestSettingsRef.current;
    const startDraft = snapshotToDraft(startSettings);
    const current = draftRef.current;
    savingRef.current = true;
    setSaving(true);
    const savedFieldValues: Partial<SettingsDraft> = {};
    try {
      const candidates: Array<[keyof SettingsDraft, string, unknown, unknown]> = [
        ['reserve', 'safety_reserve_gib', parseNumericInput(current.reserve, 'OS Memory Safety Reserve'), startSettings.safety_reserve_gib],
        ['endpoint', 'ollama_endpoint', current.endpoint, startSettings.ollama_endpoint],
        ['profile', 'execution_profile', current.profile, startSettings.execution_profile],
        ['kvType', 'kv_cache_type', current.kvType, startSettings.kv_cache_type],
        ['defaultCtx', 'default_context_length', parseNumericInput(current.defaultCtx, 'Default Context Length'), startSettings.default_context_length],
        ['maxModels', 'max_loaded_models', parseNumericInput(current.maxModels, 'Max Loaded Models'), startSettings.max_loaded_models],
        ['numParallel', 'num_parallel', parseNumericInput(current.numParallel, 'Num Parallel'), startSettings.num_parallel],
        ['keepAlive', 'keep_alive', current.keepAlive, startSettings.keep_alive],
        ['numBatch', 'num_batch', current.numBatch.trim() ? Number(current.numBatch) : null, startSettings.num_batch],
        ['numUbatch', 'num_ubatch', current.numUbatch.trim() ? Number(current.numUbatch) : null, startSettings.num_ubatch],
        ['numThread', 'num_thread', current.numThread.trim() ? Number(current.numThread) : null, startSettings.num_thread],
        ['pollMs', 'telemetry_poll_ms', parseNumericInput(current.pollMs, 'Telemetry Poll'), startSettings.telemetry_poll_ms],
        ['mgmtMode', 'ollama_management_mode', current.mgmtMode, startSettings.ollama_management_mode],
      ];
      for (const [field, key, nextVal, prevVal] of candidates) {
        if (nextVal !== prevVal) {
          await onSaveSetting(key, nextVal);
          savedFieldValues[field] = current[field];
        }
      }
      setSavedNotice('Settings saved locally to SQLite.');
    } catch (err) {
      setErrorNotice(toErrorMessage(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
      const latestDraft = snapshotToDraft(latestSettingsRef.current);
      const prevSynced = syncedDraftRef.current;
      const currDraft = draftRef.current;
      const nextSynced = { ...latestDraft };
      const nextDraft = { ...currDraft };
      for (const field of Object.keys(latestDraft) as Array<keyof SettingsDraft>) {
        const propChangedDuringSave = latestDraft[field] !== startDraft[field];
        const wasSaved = field in savedFieldValues;
        if (propChangedDuringSave && (wasSaved || currDraft[field] === prevSynced[field])) {
          nextDraft[field] = latestDraft[field];
          nextSynced[field] = latestDraft[field];
        } else if (wasSaved) {
          nextSynced[field] = savedFieldValues[field]!;
        } else if (currDraft[field] === prevSynced[field]) {
          nextDraft[field] = latestDraft[field];
          nextSynced[field] = latestDraft[field];
        }
      }
      syncedDraftRef.current = nextSynced;
      setDraft(nextDraft);
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
              <input type="number" min={0.5} max={64} step={0.5} className="mosaic-input" value={draft.reserve} onChange={(e) => setField('reserve', e.target.value)} />
            </label>
            <label className="mosaic-field">
              <span>Ollama Loopback Endpoint</span>
              <input type="url" className="mosaic-input" value={draft.endpoint} onChange={(e) => setField('endpoint', e.target.value)} />
            </label>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Execution Profile</span>
                <select className="mosaic-input" value={draft.profile} onChange={(e) => setField('profile', e.target.value)}>
                  <option value="auto_adaptive">auto_adaptive</option>
                  <option value="max_quality">max_quality</option>
                  <option value="balanced">balanced</option>
                  <option value="constrained_memory">constrained_memory</option>
                </select>
              </label>
              <label className="mosaic-field">
                <span>KV Cache Type</span>
                <select className="mosaic-input" value={draft.kvType} onChange={(e) => setField('kvType', e.target.value)}>
                  <option value="auto">auto</option>
                  <option value="f16">f16</option>
                  <option value="q8_0">q8_0</option>
                  <option value="q4_0">q4_0</option>
                </select>
              </label>
              <label className="mosaic-field">
                <span>Default Context Length</span>
                <input type="number" min={512} max={131072} step={512} className="mosaic-input" value={draft.defaultCtx} onChange={(e) => setField('defaultCtx', e.target.value)} />
              </label>
            </div>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Max Loaded Models</span>
                <input type="number" min={1} max={8} className="mosaic-input" value={draft.maxModels} onChange={(e) => setField('maxModels', e.target.value)} />
              </label>
              <label className="mosaic-field">
                <span>Num Parallel</span>
                <input type="number" min={1} max={8} className="mosaic-input" value={draft.numParallel} onChange={(e) => setField('numParallel', e.target.value)} />
              </label>
              <label className="mosaic-field">
                <span>Keep Alive</span>
                <input type="text" className="mosaic-input" value={draft.keepAlive} onChange={(e) => setField('keepAlive', e.target.value)} />
              </label>
            </div>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Batch (optional)</span>
                <input type="number" min={1} max={8192} className="mosaic-input" placeholder="Auto" value={draft.numBatch} onChange={(e) => setField('numBatch', e.target.value)} />
              </label>
              <label className="mosaic-field">
                <span>UBatch (optional)</span>
                <input type="number" min={1} max={8192} className="mosaic-input" placeholder="Auto" value={draft.numUbatch} onChange={(e) => setField('numUbatch', e.target.value)} />
              </label>
              <label className="mosaic-field">
                <span>Threads (optional)</span>
                <input type="number" min={1} max={1024} className="mosaic-input" placeholder="Auto" value={draft.numThread} onChange={(e) => setField('numThread', e.target.value)} />
              </label>
            </div>
            <div className="mosaic-worker-grid">
              <label className="mosaic-field">
                <span>Telemetry Poll (ms)</span>
                <input type="number" min={500} max={30000} step={500} className="mosaic-input" value={draft.pollMs} onChange={(e) => setField('pollMs', e.target.value)} />
              </label>
              <label className="mosaic-field">
                <span>Ollama Management</span>
                <select className="mosaic-input" value={draft.mgmtMode} onChange={(e) => setField('mgmtMode', e.target.value)}>
                  <option value="managed_or_detected">managed_or_detected</option>
                  <option value="managed_only">managed_only</option>
                  <option value="external_only">external_only</option>
                </select>
              </label>
            </div>
            <div className="mosaic-card-actions">
              <button type="button" className="mosaic-button" disabled={saving} onClick={() => void handleSave()}>
                {saving ? 'Saving...' : 'Save Settings'}
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
