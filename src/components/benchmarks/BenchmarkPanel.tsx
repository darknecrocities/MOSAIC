import { useState } from 'react';
import { Activity, Download, Gauge } from 'lucide-react';
import type { BenchmarkReportRecord, PerformanceAnalysisReport } from '../../types/ipc';
import { formatGiB } from '../../utils/format';
import { mosaicApi } from '../../utils/mosaicApi';
import { toErrorMessage } from '../../utils/tauriClient';

interface BenchmarkPanelProps {
  reports: BenchmarkReportRecord[];
  benchmarkingModel: string | null;
  onExport: (reportId: string, format: 'json' | 'csv' | 'html') => void;
}

export function BenchmarkPanel({ reports, benchmarkingModel, onExport }: BenchmarkPanelProps) {
  const [analyses, setAnalyses] = useState<Record<string, PerformanceAnalysisReport>>({});
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const handleAnalyze = async (reportId: string) => {
    setAnalyzingId(reportId);
    setAnalysisError(null);
    try {
      const report = await mosaicApi.analyzeBenchmarkPerformance(reportId);
      setAnalyses((prev) => ({ ...prev, [reportId]: report }));
    } catch (err) {
      setAnalysisError(toErrorMessage(err, 'Benchmark analysis failed.'));
    } finally {
      setAnalyzingId(null);
    }
  };

  return (
    <section className="mosaic-panel" aria-labelledby="benchmark-history-heading">
      <div className="mosaic-panel-header">
        <div className="mosaic-inline-row">
          <Gauge size={16} className="mosaic-icon-accent" aria-hidden="true" />
          <h2 id="benchmark-history-heading">Local Benchmark Reports</h2>
        </div>
      </div>

      {benchmarkingModel && (
        <p className="mosaic-callout mosaic-callout-info">
          Benchmarking {benchmarkingModel}...
        </p>
      )}
      {analysisError && <p className="mosaic-callout mosaic-callout-error">{analysisError}</p>}

      {reports.length === 0 ? (
        <p className="mosaic-subtitle">
          No local benchmarks recorded yet. Click Benchmark on any installed model to measure cold
          load, warm load, TTFT, and generation speed.
        </p>
      ) : (
        <div className="mosaic-stack-sm">
          {reports.map((r) => {
            const analysis = analyses[r.id];
            const recommendations = analysis?.recommendations ?? analysis?.suggestions ?? [];
            const ratios =
              analysis?.efficiency_ratios ??
              (analysis?.efficiency_ratio != null ? { efficiency: analysis.efficiency_ratio } : null);

            return (
              <div key={r.id} className="mosaic-panel-white">
                <div className="mosaic-panel-header">
                  <strong>{r.model_name}</strong>
                  <span className="mosaic-num mosaic-metric-lg">
                    {r.tok_per_sec_median !== null ? `${r.tok_per_sec_median} tok/s` : 'n/a'}
                  </span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">Cold / Warm Load</span>
                  <span className="mosaic-num">
                    {r.cold_load_ms !== null ? `${(r.cold_load_ms / 1000).toFixed(1)}s` : 'n/a'} /{' '}
                    {r.warm_load_ms !== null ? `${r.warm_load_ms} ms` : 'n/a'}
                  </span>
                </div>
                <div className="mosaic-kv">
                  <span className="mosaic-kv-label">TTFT Median / Peak RAM</span>
                  <span className="mosaic-num">
                    {r.ttft_median_ms !== null ? `${r.ttft_median_ms} ms` : 'n/a'} /{' '}
                    {r.peak_ram_bytes ? formatGiB(r.peak_ram_bytes) : 'n/a'}
                  </span>
                </div>
                <div className="mosaic-card-actions">
                  <button
                    type="button"
                    className="mosaic-button-secondary"
                    disabled={analyzingId === r.id}
                    onClick={() => void handleAnalyze(r.id)}
                  >
                    <Activity size={13} aria-hidden="true" />
                    <span>{analyzingId === r.id ? 'Analyzing...' : 'Analyze Bottlenecks'}</span>
                  </button>
                  {(['json', 'csv', 'html'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      className="mosaic-button-secondary"
                      onClick={() => onExport(r.id, fmt)}
                    >
                      <Download size={13} aria-hidden="true" />
                      <span>Export {fmt.toUpperCase()}</span>
                    </button>
                  ))}
                </div>

                {analysis && (
                  <div className="mosaic-panel mosaic-stack-sm" aria-label={`Performance analysis for ${r.model_name}`}>
                    {analysis.summary && <p className="mosaic-subtitle">{analysis.summary}</p>}
                    {ratios && Object.entries(ratios).map(([k, v]) => (
                      <div key={k} className="mosaic-kv">
                        <span className="mosaic-kv-label">{k}</span>
                        <span className="mosaic-num">{String(v)}</span>
                      </div>
                    ))}
                    {analysis.bottlenecks.length > 0 && (
                      <ul className="mosaic-list">
                        {analysis.bottlenecks.map((b, idx) => {
                          const label = b.category ?? b.component ?? b.type ?? 'bottleneck';
                          const severity = b.severity ? ` (${String(b.severity)})` : '';
                          const detail =
                            b.explanation ?? b.detail ?? b.summary ?? b.message ?? JSON.stringify(b);
                          return (
                            <li key={idx} className="mosaic-subtitle">
                              {String(label)}{severity}: {String(detail)}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {recommendations.length > 0 && (
                      <ul className="mosaic-list">
                        {recommendations.map((rec) => (
                          <li key={rec} className="mosaic-subtitle">{rec}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
