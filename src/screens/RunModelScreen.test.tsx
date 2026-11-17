import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunModelScreen } from './RunModelScreen';

describe('RunModelScreen', () => {
  it('shows local privacy indicator and blocks input when external drive is disconnected', () => {
    render(
      <RunModelScreen
        models={[{ name: 'llama3.2:1b', size_bytes: 1_300_000_000, digest: 'abc', modified_at: '', family: null, parameter_size: null, quantization_level: 'Q8_0' }]}
        selectedModel="llama3.2:1b"
        libraryConnected={false}
        ollamaReachable={true}
        streaming={false}
        messages={[]}
        onSelectModel={vi.fn()}
        onSendMessage={vi.fn()}
        onStopGeneration={vi.fn()}
        onUnloadModel={vi.fn()}
      />
    );

    expect(screen.getByText('Running locally through Ollama')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt input')).toBeDisabled();
  });
});
