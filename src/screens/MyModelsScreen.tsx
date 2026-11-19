import { useState } from 'react';
import { FileText, Gauge, Play, Trash2 } from 'lucide-react';
import { BenchmarkPanel } from '../components/benchmarks/BenchmarkPanel';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { ModelShowModal } from '../components/models/ModelShowModal';
import type { BenchmarkReportRecord, InstalledModel, ModelShowDetails } from '../types/ipc';
import { formatGiB } from '../utils/format';
import { mosaicApi } from '../utils/mosaicApi';
import { toErrorMessage } from '../utils/tauriClient';

interface MyModelsScreenProps {
  models: InstalledModel[];
  reports: BenchmarkReportRecord[];
  loading: boolean;
  libraryConnected: boolean;
  benchmarkingModel: string | null;
  onRefresh: () => void;
  onLaunchModel: (modelName: string) => void;
  onRunBenchmark: (modelName: string, contextLength?: number, repetitions?: number) => Promise<void>;
  onExportReport: (reportId: string, format: 'json' | 'csv' | 'html') => void;
  onDeleteModel: (modelName: string) => Promise<void>;
}

const BENCH_CONTEXTS = [2048, 4096, 8192, 16384, 32768];

export function MyModelsScreen({
  models,
  reports,
  loading,
  libraryConnected,
  benchmarkingModel,
  onRefresh,
  onLaunchModel,
  onRunBenchmark,
  onExportReport,
  onDeleteModel,
}: MyModelsScreenProps) {
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [benchContext, setBenchContext] = useState(4096);
  const [benchRepsRaw, setBenchRepsRaw] = useState('2');
  const [showTarget, setShowTarget] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState<ModelShowDetails | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [showError, setShowError] = useState<string | null>(null);

  const parsedReps = Number(benchRepsRaw);
  const benchReps = Number.isFinite(parsedReps) && benchRepsRaw.trim() !== ''
    ? Math.min(5, Math.max(2, Math.round(parsedReps)))
    : 2;

  const handleInspectModel = async (name: string) => {
    setShowTarget(name);
    setShowDetails(null);
    setShowError(null);
    setShowLoading(true);
    try {
      setShowDetails(await mosaicApi.showModelDetails(name));
    } catch (err) {
      setShowError(toErrorMessage(err, 'Failed to inspect model metadata.'));
    } finally {
      setShowLoading(false);
    }
  };

  return (
    <div className="mosaic-stack">
      <section className="mosaic-panel" aria-labelledby="my-models-heading">
        <div className="mosaic-panel-header">
          <div>
            <h2 id="my-models-heading">My Models</h2>
            <span className="mosaic-subtitle">
              Ollama models stored on your selected external library
            </span>
          </div>
          <button type="button" className="mosaic-button-secondary" onClick={onRefresh}>
            {loading ? 'Refreshing...' : 'Refresh Inventory'}
          </button>
        </div>

        <div className="mosaic-toolbar">
          <label className="mosaic-field">
            <span>Benchmark context</span>
            <select
              className="mosaic-input"
              aria-label="Benchmark context length"
              value={benchContext}
              onChange={(e) => setBenchContext(Number(e.target.value))}
            >
              {BENCH_CONTEXTS.map((ctx) => (
                <option key={ctx} value={ctx}>{ctx.toLocaleString()} tokens</option>
              ))}
            </select>
          </label>
          <label className="mosaic-field">
            <span>Repetitions</span>
            <input
              type="number"
              min={2}
              max={5}
              step={1}
              className="mosaic-input"
              aria-label="Benchmark repetitions"
              value={benchRepsRaw}
              onChange={(e) => setBenchRepsRaw(e.target.value)}
              onBlur={() => setBenchRepsRaw(String(benchReps))}
            />
          </label>
        </div>

        {!libraryConnected && (
          <p className="mosaic-callout mosaic-callout-warn">
            External drive disconnected — connect your library to run or manage models.
          </p>
        )}

        {models.length === 0 ? (
          <p className="mosaic-subtitle">
            No downloaded models detected in the configured Ollama library.
          </p>
        ) : (
          <div className="mosaic-grid mosaic-stack-sm">
            {models.map((m) => (
              <article key={m.name} className="mosaic-panel-white">
                <div className="mosaic-panel-header">
                  <h3>{m.name}</h3>
                  <span className="mosaic-num">{formatGiB(m.size_bytes)}</span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Quantization</span>
                  <span>{m.quantization_level ?? 'unknown'}</span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Digest</span>
                  <code>{m.digest.slice(0, 12)}</code>
                </div>
                <div className="mosaic-card-actions">
                  <button
                    type="button"
                    className="mosaic-button"
                    disabled={!libraryConnected}
                    onClick={() => onLaunchModel(m.name)}
                  >
                    <Play size={15} aria-hidden="true" />
                    <span>Run</span>
                  </button>
                  <button
                    type="button"
                    className="mosaic-icon-btn"
                    onClick={() => void handleInspectModel(m.name)}
                    aria-label={`Inspect ${m.name}`}
                    title="Show Metadata"
                  >
                    <FileText size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="mosaic-icon-btn"
                    disabled={!libraryConnected || benchmarkingModel !== null}
                    onClick={() => void onRunBenchmark(m.name, benchContext, benchReps)}
                    aria-label={`Benchmark ${m.name}`}
                    title={`Benchmark ${m.name}`}
                  >
                    <Gauge size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="mosaic-icon-btn mosaic-button-danger"
                    disabled={!libraryConnected}
                    onClick={() => setConfirmTarget(m.name)}
                    aria-label={`Delete ${m.name}`}
                    title={`Delete ${m.name}`}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <BenchmarkPanel
        reports={reports}
        benchmarkingModel={benchmarkingModel}
        onExport={onExportReport}
      />

      <ModelShowModal
        open={showTarget !== null}
        modelName={showTarget}
        loading={showLoading}
        error={showError}
        details={showDetails}
        onClose={() => setShowTarget(null)}
      />

      <ConfirmModal
        open={confirmTarget !== null}
        title="Delete Model Weights"
        description={`Remove ${confirmTarget ?? ''} from your external Ollama model library? This cannot be undone without re-downloading.`}
        confirmLabel="Delete Model"
        variant="danger"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          const target = confirmTarget;
          setConfirmTarget(null);
          if (target) void onDeleteModel(target);
        }}
      />
    </div>
  );
}
