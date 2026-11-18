import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_BOOTSTRAP } from '../test-utils/mockFixtures';
import { installTauriTestBridge, type TauriTestController } from '../test-utils/mockTauri';
import { SettingsScreen } from './SettingsScreen';

describe('SettingsScreen', () => {
  let tauri: TauriTestController;

  beforeEach(() => {
    tauri = installTauriTestBridge();
  });

  afterEach(() => {
    tauri.uninstall();
  });

  it('saves all 13 runtime settings, loads diagnostics with limit, and manages cluster workers', async () => {
    const onSaveSetting = vi.fn().mockResolvedValue(undefined);
    render(<SettingsScreen settings={SAMPLE_BOOTSTRAP.settings} onSaveSetting={onSaveSetting} />);

    await waitFor(() => {
      expect(screen.getByText(/Started managed Ollama/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Diagnostics limit'), { target: { value: '100' } });
    await waitFor(() => {
      expect(tauri.callsFor('get_diagnostics').some((c) => c.args.limit === 100)).toBe(true);
    });

    fireEvent.change(screen.getByLabelText('OS Memory Safety Reserve (GiB)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => {
      expect(screen.getByText('Settings saved locally to SQLite.')).toBeInTheDocument();
    });
    expect(onSaveSetting).toHaveBeenCalledTimes(13);
    expect(onSaveSetting).toHaveBeenCalledWith('safety_reserve_gib', 4);

    fireEvent.change(screen.getByLabelText('Worker name'), { target: { value: 'Node-B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Worker' }));
    await waitFor(() => {
      expect(tauri.callsFor('add_cluster_worker')).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Probe Reachability' }));
    await waitFor(() => {
      expect(tauri.callsFor('probe_cluster_workers')).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove RTX-PC' }));
    await waitFor(() => {
      expect(tauri.callsFor('remove_cluster_worker')[0]?.args).toEqual({ id: 'w-1' });
    });
  });

  it('renders empty state when get_diagnostics returns no entries', async () => {
    tauri.setHandler('get_diagnostics', () => []);
    render(<SettingsScreen settings={SAMPLE_BOOTSTRAP.settings} onSaveSetting={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('No diagnostics entries recorded yet.')).toBeInTheDocument();
    });
  });
});
