import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_BOOTSTRAP } from '../test-utils/mockFixtures';
import { installTauriTestBridge, type TauriTestController } from '../test-utils/mockTauri';
import { ExternalStorageScreen } from './ExternalStorageScreen';

describe('ExternalStorageScreen', () => {
  let tauri: TauriTestController;

  beforeEach(() => {
    tauri = installTauriTestBridge();
  });

  afterEach(() => {
    tauri.uninstall();
  });

  it('gates Start/Stop Managed Ollama, Prepare Eject, OLLAMA_MODELS, and migration behind ConfirmModal', async () => {
    const onConfigureOllamaStorage = vi.fn().mockResolvedValue(undefined);
    const onStartManagedOllama = vi.fn().mockResolvedValue(undefined);
    const onStopManagedOllama = vi.fn().mockResolvedValue(undefined);
    const onSafeEject = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <ExternalStorageScreen
        state={{ ...SAMPLE_BOOTSTRAP, ollama: { ...SAMPLE_BOOTSTRAP.ollama, api_reachable: false } }}
        selecting={false}
        onSelectVolume={vi.fn()}
        onInspectHardware={vi.fn()}
        onConfigureOllamaStorage={onConfigureOllamaStorage}
        onStartManagedOllama={onStartManagedOllama}
        onStopManagedOllama={onStopManagedOllama}
        onSafeEject={onSafeEject}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /Migrate Internal Models/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Start Managed Ollama' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Start Managed Ollama' })[1]);
    expect(onStartManagedOllama).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Configure OLLAMA_MODELS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply Configuration' }));
    expect(onConfigureOllamaStorage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Prepare Eject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Eject Safely' }));
    expect(onSafeEject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Migrate Internal Models/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to External Drive' }));
    await waitFor(() => {
      expect(tauri.callsFor('execute_internal_migration')[0]?.args).toEqual({ confirmed: true });
    });

    rerender(
      <ExternalStorageScreen
        state={SAMPLE_BOOTSTRAP}
        selecting={false}
        onSelectVolume={vi.fn()}
        onInspectHardware={vi.fn()}
        onConfigureOllamaStorage={onConfigureOllamaStorage}
        onStartManagedOllama={onStartManagedOllama}
        onStopManagedOllama={onStopManagedOllama}
        onSafeEject={onSafeEject}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop Managed Ollama' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop Managed Ollama' })[1]);
    expect(onStopManagedOllama).toHaveBeenCalledTimes(1);
  });
});
