import { useState } from 'react';
import { Lock, Play, RotateCcw, Send, Square } from 'lucide-react';
import type {
  ChatMessage,
  ExecutionProfile,
  InstalledModel,
  KvCacheType,
  ResourceTelemetry,
} from '../types/ipc';
import { formatGiB } from '../utils/format';

interface RunModelScreenProps {
  models: InstalledModel[];
  selectedModel: string;
  libraryConnected: boolean;
  ollamaReachable: boolean;
  streaming: boolean;
  messages: ChatMessage[];
  telemetry?: ResourceTelemetry | null;
  executionProfile?: ExecutionProfile;
  kvCacheType?: KvCacheType;
  onSelectModel: (name: string) => void;
  onSendMessage: (
    prompt: string,
    numCtx: number,
    temperature: number,
    opts?: { executionProfile: ExecutionProfile; kvCacheType: KvCacheType; numGpu: number | null }
  ) => void;
  onStopGeneration: () => void;
  onUnloadModel: () => void;
  onNewSession?: () => void;
  onStartManagedOllama?: () => Promise<void>;
}

const RUN_CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536];

export function RunModelScreen({
  models,
  selectedModel,
  libraryConnected,
  ollamaReachable,
  streaming,
  messages,
  telemetry,
  executionProfile: initialProfile = 'auto_adaptive',
  kvCacheType: initialKv = 'auto',
  onSelectModel,
  onSendMessage,
  onStopGeneration,
  onUnloadModel,
  onNewSession,
  onStartManagedOllama,
}: RunModelScreenProps) {
  const [prompt, setPrompt] = useState('');
  const [numCtx, setNumCtx] = useState(4096);
  const [temperature, setTemperature] = useState(0.2);
  const [executionProfile, setExecutionProfile] = useState<ExecutionProfile>(initialProfile);
  const [kvCacheType, setKvCacheType] = useState<KvCacheType>(initialKv);
  const [numGpuRaw, setNumGpuRaw] = useState('');

  const canRun = libraryConnected && ollamaReachable && Boolean(selectedModel) && !streaming;

  const submitPrompt = () => {
    const trimmed = prompt.trim();
    if (!trimmed || !canRun) return;
    const parsedGpu = numGpuRaw.trim() === '' ? null : Number(numGpuRaw);
    setPrompt('');
    onSendMessage(trimmed, numCtx, temperature, {
      executionProfile,
      kvCacheType,
      numGpu: parsedGpu !== null && Number.isFinite(parsedGpu) ? parsedGpu : null,
    });
  };

  return (
    <div className="mosaic-run-workspace">
      <section className="mosaic-panel-white" aria-label="Conversation">
        <div className="mosaic-panel-header">
          <div>
            <h2 id="run-heading">Run Model</h2>
            <span className="mosaic-subtitle">
              In-memory session (conversations are not persisted by default)
            </span>
          </div>
          {ollamaReachable && (
            <span className="mosaic-caption-inline">
              <Lock size={13} aria-hidden="true" />
              <span>Running locally through Ollama</span>
            </span>
          )}
        </div>

        {!ollamaReachable && libraryConnected && onStartManagedOllama && (
          <div className="mosaic-callout mosaic-callout-warn mosaic-stack-sm">
            <span>Ollama runtime is offline.</span>
            <div className="mosaic-card-actions">
              <button
                type="button"
                className="mosaic-button"
                onClick={() => void onStartManagedOllama()}
              >
                <Play size={14} aria-hidden="true" />
                <span>Start Managed Ollama</span>
              </button>
            </div>
          </div>
        )}

        {messages.length === 0 ? (
          <p className="mosaic-subtitle">
            {!libraryConnected
              ? 'Connect your external drive before starting local inference.'
              : 'Send a prompt to begin local streaming inference.'}
          </p>
        ) : (
          <div className="mosaic-stack-sm">
            {messages.map((msg, idx) => (
              <div
                key={`${msg.role}-${idx}`}
                className={msg.role === 'user' ? 'mosaic-panel' : 'mosaic-panel-white'}
              >
                <strong>{msg.role === 'user' ? 'You' : selectedModel || 'Assistant'}</strong>
                <p className="mosaic-prewrap">{msg.content}</p>
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitPrompt();
          }}
          className="mosaic-stack-sm"
        >
          <textarea
            className="mosaic-textarea"
            rows={2}
            placeholder="Ask anything locally..."
            aria-label="Prompt input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitPrompt();
              }
            }}
            disabled={!libraryConnected || !ollamaReachable}
          />
          <div className="mosaic-card-actions">
            {streaming ? (
              <button type="button" className="mosaic-button-danger" onClick={onStopGeneration}>
                <Square size={15} aria-hidden="true" />
                <span>Stop</span>
              </button>
            ) : (
              <button type="submit" className="mosaic-button" disabled={!canRun || !prompt.trim()}>
                <Send size={15} aria-hidden="true" />
                <span>Send</span>
              </button>
            )}
            {onNewSession && (
              <button type="button" className="mosaic-button-secondary" onClick={onNewSession}>
                <RotateCcw size={14} aria-hidden="true" />
                <span>New Session</span>
              </button>
            )}
          </div>
        </form>
      </section>

      <aside className="mosaic-panel mosaic-stack-sm" aria-label="Runtime parameters">
        <h3>Runtime Parameters</h3>
        {telemetry && (
          <div className="mosaic-kv">
            <span className="mosaic-kv-label">Free RAM</span>
            <span className="mosaic-num">
              {formatGiB(telemetry.ram_available_bytes)} / {formatGiB(telemetry.ram_total_bytes)}
            </span>
          </div>
        )}
        <label className="mosaic-field">
          <span>Installed Model</span>
          <select
            className="mosaic-input"
            aria-label="Select installed model"
            value={selectedModel}
            onChange={(e) => onSelectModel(e.target.value)}
          >
            <option value="">Select an installed model...</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        </label>
        <label className="mosaic-field">
          <span>Context Length</span>
          <select
            className="mosaic-input"
            aria-label="Context length"
            value={numCtx}
            onChange={(e) => setNumCtx(Number(e.target.value))}
          >
            {RUN_CONTEXTS.map((ctx) => (
              <option key={ctx} value={ctx}>Context: {ctx.toLocaleString()}</option>
            ))}
          </select>
        </label>
        <label className="mosaic-field">
          <span>Execution Profile</span>
          <select
            className="mosaic-input"
            aria-label="Execution profile"
            value={executionProfile}
            onChange={(e) => setExecutionProfile(e.target.value as ExecutionProfile)}
          >
            <option value="auto_adaptive">auto_adaptive</option>
            <option value="max_quality">max_quality</option>
            <option value="balanced">balanced</option>
            <option value="constrained_memory">constrained_memory</option>
          </select>
        </label>
        <label className="mosaic-field">
          <span>KV Cache Quant</span>
          <select
            className="mosaic-input"
            aria-label="KV cache"
            value={kvCacheType}
            onChange={(e) => setKvCacheType(e.target.value as KvCacheType)}
          >
            <option value="auto">auto</option>
            <option value="f16">f16</option>
            <option value="q8_0">q8_0</option>
            <option value="q4_0">q4_0</option>
          </select>
        </label>
        <label className="mosaic-field">
          <span>GPU Layers (optional)</span>
          <input
            type="number"
            className="mosaic-input"
            aria-label="GPU layers"
            placeholder="Auto"
            min={0}
            max={256}
            value={numGpuRaw}
            onChange={(e) => setNumGpuRaw(e.target.value)}
          />
        </label>
        <label className="mosaic-field">
          <span>Temperature</span>
          <input
            type="number"
            className="mosaic-input"
            aria-label="Temperature"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
          />
        </label>
        <div className="mosaic-card-actions">
          <button
            type="button"
            className="mosaic-button-secondary"
            disabled={!selectedModel || !ollamaReachable}
            onClick={onUnloadModel}
          >
            Unload Model
          </button>
        </div>
      </aside>
    </div>
  );
}
