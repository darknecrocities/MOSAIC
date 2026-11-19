import { useState } from 'react';
import { Cpu } from 'lucide-react';
import type { AppBootstrapState, HardwareAnalysisReport } from '../types/ipc';
import { formatGiB } from '../utils/format';
import { mosaicApi } from '../utils/mosaicApi';
import { toErrorMessage } from '../utils/tauriClient';

export function HardwareScreen({ state }: { state: AppBootstrapState }) {
  const { system, ollama, analytics } = state;
  const [insights, setInsights] = useState<HardwareAnalysisReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gpuVramBytes =
    system.gpu_vram_bytes ?? system.gpus.find((g) => typeof g.vram_bytes === 'number')?.vram_bytes ?? null;

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      setInsights(await mosaicApi.analyzeHardwareInsights());
    } catch (err) {
      setError(toErrorMessage(err, 'Hardware insights unavailable.'));
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="mosaic-stack">
      <div className="mosaic-grid">
        <section className="mosaic-panel" aria-labelledby="hw-profile-title">
          <div className="mosaic-panel-header">
            <h2 id="hw-profile-title">Hardware &amp; Memory Profile</h2>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Operating System</span>
            <span>{system.os_name} {system.os_version} ({system.architecture})</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Processor</span>
            <span>{system.cpu_brand} ({system.physical_cores ?? '?'}P / {system.logical_cores}T)</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Total / Available RAM</span>
            <span className="mosaic-num">
              {formatGiB(system.ram_available_bytes)} free of {formatGiB(system.ram_total_bytes)}
            </span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Unified Memory</span>
            <span>{system.is_unified_memory ? 'Yes (CPU & GPU shared)' : 'No'}</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Accelerator</span>
            <span>{system.gpu_status}</span>
          </div>
          {gpuVramBytes != null && (
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">GPU VRAM</span>
              <span className="mosaic-num">{formatGiB(gpuVramBytes)}</span>
            </div>
          )}
          {system.gpus.map((gpu, idx) => (
            <div key={`${gpu.vendor}-${gpu.model || gpu.name || idx}-${idx}`} className="mosaic-kv">
              <span className="mosaic-kv-label">{gpu.vendor} {gpu.name ?? gpu.model}</span>
              <span className="mosaic-num">
                {gpu.vram_bytes != null
                  ? `${formatGiB(gpu.vram_bytes)}${gpu.unified_memory ? ' (Unified)' : ''}`
                  : gpu.unified_memory
                    ? 'Unified Memory'
                    : 'Shared / Unknown'}
              </span>
            </div>
          ))}
          {system.metal_wired_limit_bytes != null && (
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">Metal Wired Limit</span>
              <span className="mosaic-num">{formatGiB(system.metal_wired_limit_bytes)}</span>
            </div>
          )}
        </section>

        <section className="mosaic-panel" aria-labelledby="hw-runtime-title">
          <div className="mosaic-panel-header">
            <h2 id="hw-runtime-title">Runtime &amp; Analytics</h2>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Runtime Mode</span>
            <span>{ollama.runtime_mode}</span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Ollama CLI / API</span>
            <span>
              {ollama.cli_version ?? 'not found'} /{' '}
              {ollama.api_reachable ? `reachable (${ollama.api_version ?? 'ok'})` : 'offline'}
            </span>
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Python Analytics Worker</span>
            <span>
              {analytics.available
                ? `Healthy (protocol ${analytics.protocol_version ?? '1.0'})`
                : analytics.error ?? 'Unavailable'}
            </span>
          </div>
          <div className="mosaic-card-actions">
            <button
              type="button"
              className="mosaic-button-secondary"
              disabled={analyzing}
              onClick={() => void handleAnalyze()}
            >
              <Cpu size={15} aria-hidden="true" />
              <span>{analyzing ? 'Analyzing...' : 'Analyze Hardware Insights'}</span>
            </button>
          </div>
        </section>
      </div>

      {error && <p className="mosaic-callout mosaic-callout-error">{error}</p>}

      {insights && (
        <section className="mosaic-panel-white" aria-label="Hardware capability insights">
          <div className="mosaic-panel-header">
            <h3>Hardware Capability Insights</h3>
            {(insights.confidence || insights.source) && (
              <span className="mosaic-subtitle">
                {insights.confidence ?? 'measured'}{insights.source ? ` · ${insights.source}` : ''}
              </span>
            )}
          </div>
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Effective Available RAM</span>
            <span className="mosaic-num">{formatGiB(insights.ram_effective_avail_bytes)}</span>
          </div>
          {insights.metal_wired_limit_bytes != null && (
            <div className="mosaic-kv">
              <span className="mosaic-kv-label">Effective Metal Wired Cap</span>
              <span className="mosaic-num">{formatGiB(insights.metal_wired_limit_bytes)}</span>
            </div>
          )}
          {insights.gpu_devices.length > 0 && (
            <div className="mosaic-stack-sm">
              <span className="mosaic-eyebrow">Detected GPU Devices</span>
              {insights.gpu_devices.map((dev, idx) => (
                <div key={idx} className="mosaic-kv">
                  <span className="mosaic-kv-label">
                    {String(dev.vendor ?? '')} {String(dev.model ?? `GPU ${idx + 1}`)}
                  </span>
                  <span className="mosaic-num">
                    {typeof dev.vram_bytes === 'number' ? formatGiB(dev.vram_bytes) : 'Shared / Unknown'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {insights.limitations.length > 0 && (
            <ul className="mosaic-list">
              {insights.limitations.map((item, idx) => (
                <li key={`${item}-${idx}`} className="mosaic-subtitle">{item}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
