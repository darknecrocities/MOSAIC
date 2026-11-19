import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DiagnosticEntry } from '../../types/ipc';
import { formatTimestamp } from '../../utils/format';
import { mosaicApi } from '../../utils/mosaicApi';
import { isTauriRuntime, toErrorMessage } from '../../utils/tauriClient';

export function DiagnosticsLogPanel() {
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [limit, setLimit] = useState<number>(50);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadLogs = useCallback(async (nextLimit: number) => {
    if (!isTauriRuntime()) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await mosaicApi.getDiagnostics(nextLimit);
      if (mountedRef.current && reqIdRef.current === reqId) {
        setEntries(next);
      }
    } catch (err) {
      if (mountedRef.current && reqIdRef.current === reqId) {
        setError(toErrorMessage(err, 'Failed to load diagnostics.'));
      }
    } finally {
      if (mountedRef.current && reqIdRef.current === reqId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadLogs(limit);
  }, [loadLogs, limit]);

  return (
    <section className="mosaic-panel" aria-labelledby="diagnostics-heading">
      <div className="mosaic-panel-header">
        <h2 id="diagnostics-heading">Runtime Diagnostics Log</h2>
        <div className="mosaic-inline-row">
          <select
            className="mosaic-input"
            aria-label="Diagnostics limit"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {[20, 50, 100, 200].map((n) => (
              <option key={n} value={n}>Last {n}</option>
            ))}
          </select>
          <button
            type="button"
            className="mosaic-button-secondary"
            disabled={loading}
            onClick={() => void loadLogs(limit)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>{loading ? 'Loading...' : 'Refresh Diagnostics'}</span>
          </button>
        </div>
      </div>

      {error && <p className="mosaic-callout mosaic-callout-error">{error}</p>}

      {entries.length === 0 ? (
        <p className="mosaic-subtitle">No diagnostics entries recorded yet.</p>
      ) : (
        <div className="mosaic-diagnostics-list">
          {entries.map((entry) => (
            <div key={String(entry.id)} className="mosaic-diagnostics-row">
              <div className="mosaic-panel-header">
                <strong>[{entry.severity.toUpperCase()}] {entry.component}</strong>
                <span className="mosaic-subtitle">{formatTimestamp(entry.created_at)}</span>
              </div>
              <p className="mosaic-subtitle">{entry.message}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
