import { useState } from 'react';
import { Lock, Send, Square } from 'lucide-react';
import type { ChatMessage, InstalledModel } from '../types/ipc';

interface RunModelScreenProps {
  models: InstalledModel[];
  selectedModel: string;
  libraryConnected: boolean;
  ollamaReachable: boolean;
  streaming: boolean;
  messages: ChatMessage[];
  onSelectModel: (name: string) => void;
  onSendMessage: (prompt: string, numCtx: number, temperature: number) => void;
  onStopGeneration: () => void;
  onUnloadModel: () => void;
}

export function RunModelScreen({
  models,
  selectedModel,
  libraryConnected,
  ollamaReachable,
  streaming,
  messages,
  onSelectModel,
  onSendMessage,
  onStopGeneration,
  onUnloadModel,
}: RunModelScreenProps) {
  const [prompt, setPrompt] = useState('');
  const [numCtx, setNumCtx] = useState(4096);
  const [temperature, setTemperature] = useState(0.2);

  const canRun = libraryConnected && ollamaReachable && Boolean(selectedModel) && !streaming;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || !canRun) return;
    setPrompt('');
    onSendMessage(trimmed, numCtx, temperature);
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="mosaic-panel" aria-labelledby="run-heading">
        <div className="mosaic-panel-header">
          <div>
            <h2 id="run-heading">Run Model</h2>
            <span className="mosaic-subtitle">
              In-memory session (conversations are not persisted by default)
            </span>
          </div>
          {ollamaReachable && (
            <span className="mosaic-badge mosaic-badge-success">
              <Lock size={12} aria-hidden="true" />
              <span>Running locally through Ollama</span>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <select
            className="mosaic-input"
            aria-label="Select installed model"
            value={selectedModel}
            onChange={(e) => onSelectModel(e.target.value)}
          >
            <option value="">Select an installed model...</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>

          <select
            className="mosaic-input"
            aria-label="Context length"
            value={numCtx}
            onChange={(e) => setNumCtx(Number(e.target.value))}
          >
            <option value={2048}>Context: 2,048</option>
            <option value={4096}>Context: 4,096</option>
            <option value={8192}>Context: 8,192</option>
          </select>

          <input
            type="number"
            className="mosaic-input"
            aria-label="Temperature"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            style={{ width: 110 }}
          />

          <button
            type="button"
            className="mosaic-button-secondary"
            disabled={!selectedModel || !ollamaReachable}
            onClick={onUnloadModel}
          >
            Unload Model
          </button>
        </div>
      </section>

      <section className="mosaic-panel-white" aria-label="Conversation">
        {messages.length === 0 ? (
          <p className="mosaic-subtitle">
            {!libraryConnected
              ? 'Connect your external drive before starting local inference.'
              : 'Send a prompt to begin local streaming inference.'}
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {messages.map((msg, idx) => (
              <div
                key={`${msg.role}-${idx}`}
                className={msg.role === 'user' ? 'mosaic-panel' : 'mosaic-panel-white'}
              >
                <strong>{msg.role === 'user' ? 'You' : selectedModel || 'Assistant'}</strong>
                <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{msg.content}</p>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <input
            type="text"
            className="mosaic-input"
            style={{ flex: 1 }}
            placeholder="Ask anything locally..."
            aria-label="Prompt input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!libraryConnected || !ollamaReachable}
          />
          {streaming ? (
            <button type="button" className="mosaic-button-secondary" onClick={onStopGeneration}>
              <Square size={15} aria-hidden="true" />
              <span>Stop</span>
            </button>
          ) : (
            <button type="submit" className="mosaic-button" disabled={!canRun || !prompt.trim()}>
              <Send size={15} aria-hidden="true" />
              <span>Send</span>
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
