import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_MODELS, SAMPLE_REPORTS } from '../test-utils/mockFixtures';
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
    fireEvent.click(screen.getByRole('button', { name: `Inspect ${modelName}` }));
    await waitFor(() => {
      expect(screen.getByText(/qwen3moe/i)).toBeInTheDocument();
    });
    expect(tauri.callsFor('show_model_details')[0]?.args).toEqual({ model: modelName });
    fireEvent.click(screen.getByRole('button', { name: 'Close model metadata' }));

    fireEvent.change(screen.getByLabelText('Benchmark context length'), { target: { value: '16384' } });
    fireEvent.change(screen.getByLabelText('Benchmark repetitions'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: `Benchmark ${modelName}` }));
    expect(onRunBenchmark).toHaveBeenCalledWith(modelName, 16384, 4);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${modelName}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Model' }));
    expect(onDeleteModel).toHaveBeenCalledWith(modelName);
  });
});
