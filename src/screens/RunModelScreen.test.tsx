import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_MODELS } from '../test-utils/mockFixtures';
import { RunModelScreen } from './RunModelScreen';

describe('RunModelScreen', () => {
  it('shows local privacy indicator and blocks input when external drive is disconnected', () => {
    render(
      <RunModelScreen
        models={SAMPLE_MODELS}
        selectedModel={SAMPLE_MODELS[0].name}
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

  it('supports textarea Enter/Shift+Enter, 32768 context, adaptive options, Stop, Unload, and New Session', () => {
    const onSendMessage = vi.fn();
    const onStopGeneration = vi.fn();
    const onUnloadModel = vi.fn();
    const onNewSession = vi.fn();

    const { rerender } = render(
      <RunModelScreen
        models={SAMPLE_MODELS}
        selectedModel={SAMPLE_MODELS[0].name}
        libraryConnected={true}
        ollamaReachable={true}
        streaming={false}
        messages={[]}
        onSelectModel={vi.fn()}
        onSendMessage={onSendMessage}
        onStopGeneration={onStopGeneration}
        onUnloadModel={onUnloadModel}
        onNewSession={onNewSession}
      />
    );

    const promptBox = screen.getByLabelText('Prompt input');
    expect(promptBox.tagName).toBe('TEXTAREA');

    fireEvent.change(promptBox, { target: { value: '   ' } });
    fireEvent.keyDown(promptBox, { key: 'Enter', shiftKey: false });
    expect(onSendMessage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Context length'), { target: { value: '32768' } });
    fireEvent.change(screen.getByLabelText('Execution profile'), { target: { value: 'constrained_memory' } });
    fireEvent.change(screen.getByLabelText('KV cache'), { target: { value: 'q4_0' } });
    fireEvent.change(screen.getByLabelText('GPU layers'), { target: { value: '24' } });

    fireEvent.change(promptBox, { target: { value: 'Explain MoE routing' } });
    fireEvent.keyDown(promptBox, { key: 'Enter', shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(promptBox, { key: 'Enter', shiftKey: false });
    expect(onSendMessage).toHaveBeenCalledWith('Explain MoE routing', 32768, 0.2, {
      executionProfile: 'constrained_memory',
      kvCacheType: 'q4_0',
      numGpu: 24,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Unload Model' }));
    expect(onUnloadModel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'New Session' }));
    expect(onNewSession).toHaveBeenCalledTimes(1);

    rerender(
      <RunModelScreen
        models={SAMPLE_MODELS}
        selectedModel={SAMPLE_MODELS[0].name}
        libraryConnected={true}
        ollamaReachable={true}
        streaming={true}
        messages={[]}
        onSelectModel={vi.fn()}
        onSendMessage={onSendMessage}
        onStopGeneration={onStopGeneration}
        onUnloadModel={onUnloadModel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStopGeneration).toHaveBeenCalledTimes(1);
  });

  it('syncs defaultContextLength, executionProfile, and kvCacheType when props update after mount', () => {
    const { rerender } = render(
      <RunModelScreen
        models={SAMPLE_MODELS}
        selectedModel={SAMPLE_MODELS[0].name}
        libraryConnected={true}
        ollamaReachable={true}
        streaming={false}
        messages={[]}
        defaultContextLength={8192}
        executionProfile="balanced"
        kvCacheType="q8_0"
        onSelectModel={vi.fn()}
        onSendMessage={vi.fn()}
        onStopGeneration={vi.fn()}
        onUnloadModel={vi.fn()}
      />
    );

    expect((screen.getByLabelText('Context length') as HTMLSelectElement).value).toBe('8192');
    expect((screen.getByLabelText('Execution profile') as HTMLSelectElement).value).toBe('balanced');
    expect((screen.getByLabelText('KV cache') as HTMLSelectElement).value).toBe('q8_0');

    rerender(
      <RunModelScreen
        models={SAMPLE_MODELS}
        selectedModel={SAMPLE_MODELS[0].name}
        libraryConnected={true}
        ollamaReachable={true}
        streaming={false}
        messages={[]}
        defaultContextLength={16384}
        executionProfile="constrained_memory"
        kvCacheType="q4_0"
        onSelectModel={vi.fn()}
        onSendMessage={vi.fn()}
        onStopGeneration={vi.fn()}
        onUnloadModel={vi.fn()}
      />
    );

    expect((screen.getByLabelText('Context length') as HTMLSelectElement).value).toBe('16384');
    expect((screen.getByLabelText('Execution profile') as HTMLSelectElement).value).toBe('constrained_memory');
    expect((screen.getByLabelText('KV cache') as HTMLSelectElement).value).toBe('q4_0');
  });
});
