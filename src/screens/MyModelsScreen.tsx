import { useState } from 'react';
import { Gauge, Play, Trash2 } from 'lucide-react';
import { BenchmarkPanel } from '../components/benchmarks/BenchmarkPanel';
import { ConfirmModal } from '../components/common/ConfirmModal';
import type { BenchmarkReportRecord, InstalledModel } from '../types/ipc';
import { formatGiB } from '../utils/format';

interface MyModelsScreenProps {
  models: InstalledModel[];
  reports: BenchmarkReportRecord[];
  loading: boolean;
  libraryConnected: boolean;
  benchmarkingModel: string | null;
  onRefresh: () => void;
  onLaunchModel: (modelName: string) => void;
  onRunBenchmark: (modelName: string) => Promise<void>;
  onExportReport: (reportId: string, format: 'json' | 'csv' | 'html') => void;
  onDeleteModel: (modelName: string) => Promise<void>;
}

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

  return (
    <div style={{ display: 'grid', gap: 16 }}>
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

        {!libraryConnected && (
          <p className="mosaic-badge mosaic-badge-warn">
            External drive disconnected — connect your library to run or manage models.
          </p>
        )}

        {models.length === 0 ? (
          <p className="mosaic-subtitle" style={{ marginTop: 12 }}>
            No downloaded models detected in the configured Ollama library.
          </p>
        ) : (
          <div className="mosaic-grid" style={{ marginTop: 12 }}>
            {models.map((m) => (
              <article key={m.name} className="mosaic-panel-white">
                <div className="mosaic-panel-header">
                  <h3>{m.name}</h3>
                  <span className="mosaic-badge">{formatGiB(m.size_bytes)}</span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Quantization</span>
                  <span>{m.quantization_level ?? 'unknown'}</span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Digest</span>
                  <code>{m.digest.slice(0, 12)}</code>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    className="mosaic-button"
                    style={{ flex: 1 }}
                    disabled={!libraryConnected}
                    onClick={() => onLaunchModel(m.name)}
                  >
                    <Play size={15} aria-hidden="true" />
                    <span>Run</span>
                  </button>
                  <button
                    type="button"
                    className="mosaic-button-secondary"
                    disabled={!libraryConnected || benchmarkingModel !== null}
                    onClick={() => void onRunBenchmark(m.name)}
                    aria-label={`Benchmark ${m.name}`}
                  >
                    <Gauge size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="mosaic-button-secondary"
                    disabled={!libraryConnected}
                    onClick={() => setConfirmTarget(m.name)}
                    aria-label={`Delete ${m.name}`}
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

      <ConfirmModal
        open={confirmTarget !== null}
        title="Delete Model Weights"
        description={`Remove ${confirmTarget ?? ''} from your external Ollama model library? This cannot be undone without re-downloading.`}
        confirmLabel="Delete Model"
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
