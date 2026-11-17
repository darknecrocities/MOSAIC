import { Download, Gauge } from 'lucide-react';
import type { BenchmarkReportRecord } from '../../types/ipc';
import { formatGiB } from '../../utils/format';

interface BenchmarkPanelProps {
  reports: BenchmarkReportRecord[];
  benchmarkingModel: string | null;
  onExport: (reportId: string, format: 'json' | 'csv' | 'html') => void;
}

export function BenchmarkPanel({ reports, benchmarkingModel, onExport }: BenchmarkPanelProps) {
  return (
    <section className="mosaic-panel" aria-labelledby="benchmark-history-heading">
      <div className="mosaic-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Gauge size={16} color="#2878B8" aria-hidden="true" />
          <h2 id="benchmark-history-heading">Local Benchmark Reports</h2>
        </div>
        {benchmarkingModel && (
          <span className="mosaic-badge mosaic-badge-warn">
            Benchmarking {benchmarkingModel}...
          </span>
        )}
      </div>

      {reports.length === 0 ? (
        <p className="mosaic-subtitle">
          No local benchmarks recorded yet. Click Benchmark on any installed model to measure cold
          load, warm load, TTFT, and generation speed.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          {reports.map((r) => (
            <div key={r.id} className="mosaic-panel-white">
              <div className="mosaic-panel-header">
                <strong>{r.model_name}</strong>
                <span className="mosaic-badge">
                  {r.tok_per_sec_median !== null ? `${r.tok_per_sec_median} tok/s` : 'measured'}
                </span>
              </div>
              <div className="mosaic-kv">
                <span className="mosaic-kv-label">Cold / Warm Load</span>
                <span>
                  {r.cold_load_ms !== null ? `${(r.cold_load_ms / 1000).toFixed(1)}s` : 'n/a'} /{' '}
                  {r.warm_load_ms !== null ? `${r.warm_load_ms} ms` : 'n/a'}
                </span>
              </div>
              <div className="mosaic-kv">
                <span className="mosaic-kv-label">TTFT Median / Peak RAM</span>
                <span>
                  {r.ttft_median_ms !== null ? `${r.ttft_median_ms} ms` : 'n/a'} /{' '}
                  {r.peak_ram_bytes ? formatGiB(r.peak_ram_bytes) : 'n/a'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
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
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
