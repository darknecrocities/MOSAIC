import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_MODELS, SAMPLE_REPORTS, SAMPLE_SHOW_DETAILS } from '../test-utils/mockFixtures';
import { installTauriTestBridge, type TauriTestController } from '../test-utils/mockTauri';
import { MyModelsScreen } from './MyModelsScreen';

describe('MyModelsScreen', () => {
  let tauri: TauriTestController;

  beforeEach(() => {
    tauri = installTauriTestBridge();
  });

  afterEach(() => {
    tauri.uninstall();
  });

  it('opens /api/show ModelShowModal, forwards configurable benchmark opts, and confirms model deletion', async () => {
    const onRunBenchmark = vi.fn().mockResolvedValue(undefined);
    const onDeleteModel = vi.fn().mockResolvedValue(undefined);

    render(
      <MyModelsScreen
        models={SAMPLE_MODELS}
        reports={SAMPLE_REPORTS}
        loading={false}
        libraryConnected={true}
        benchmarkingModel={null}
        onRefresh={vi.fn()}
        onLaunchModel={vi.fn()}
        onRunBenchmark={onRunBenchmark}
        onExportReport={vi.fn()}
        onDeleteModel={onDeleteModel}
      />
    );

    const modelName = SAMPLE_MODELS[0].name;
    tauri.setHandler('show_model_details', () => ({
      ...SAMPLE_SHOW_DETAILS,
      model_info: { 'qwen3moe.expert_count': 128, 'qwen3moe.context_length': 131072 },
    }));

    fireEvent.click(screen.getByRole('button', { name: `Inspect ${modelName}` }));
    await waitFor(() => {
      expect(screen.getAllByText(/qwen3moe/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Apache-2.0')).toBeInTheDocument();
      expect(screen.getByText('Native Context Length')).toBeInTheDocument();
      expect(screen.getAllByText(/131072/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/expert_count/)).toBeInTheDocument();
    });
    expect(tauri.callsFor('show_model_details')[0]?.args).toEqual({ model: modelName });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const repsInput = screen.getByLabelText('Benchmark repetitions') as HTMLInputElement;
    expect(repsInput.tagName).toBe('INPUT');
    expect(repsInput.type).toBe('number');
    fireEvent.change(screen.getByLabelText('Benchmark context length'), { target: { value: '16384' } });
    fireEvent.change(repsInput, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: `Benchmark ${modelName}` }));
    expect(onRunBenchmark).toHaveBeenCalledWith(modelName, 16384, 3);

    fireEvent.change(repsInput, { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: `Benchmark ${modelName}` }));
    expect(onRunBenchmark).toHaveBeenLastCalledWith(modelName, 16384, 5);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${modelName}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Model' }));
    expect(onDeleteModel).toHaveBeenCalledWith(modelName);
  });
});
