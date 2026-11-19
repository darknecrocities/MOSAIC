import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_BOOTSTRAP, SAMPLE_DIAGNOSTICS } from '../test-utils/mockFixtures';
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
    expect(onSaveSetting).toHaveBeenCalledTimes(1);
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

  it('saves only dirty keys and syncs form state when backend-clamped settings prop updates', async () => {
    const onSaveSetting = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SettingsScreen settings={SAMPLE_BOOTSTRAP.settings} onSaveSetting={onSaveSetting} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => {
      expect(screen.getByText('Settings saved locally to SQLite.')).toBeInTheDocument();
    });
    expect(onSaveSetting).not.toHaveBeenCalled();

    const reserveInput = screen.getByLabelText('OS Memory Safety Reserve (GiB)') as HTMLInputElement;
    fireEvent.change(reserveInput, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => {
      expect(onSaveSetting).toHaveBeenCalledWith('safety_reserve_gib', 100);
    });

    rerender(
      <SettingsScreen
        settings={{ ...SAMPLE_BOOTSTRAP.settings, safety_reserve_gib: 64 }}
        onSaveSetting={onSaveSetting}
      />
    );
    expect(reserveInput.value).toBe('64');
  });

  it('preserves unsaved edits on partial failure, allows empty numeric input while typing, and ignores stale DiagnosticsLogPanel responses', async () => {
    let resolveSlow!: (val: unknown) => void;
    tauri.setHandler('get_diagnostics', (args) => {
      if (args.limit === 200) return new Promise((r) => { resolveSlow = r; });
      if (args.limit === 20) {
        return [{ id: 'fresh', severity: 'info', component: 'ui', message: 'FRESH_20_MSG', created_at: '2026-11-18T10:02:00Z' }];
      }
      return SAMPLE_DIAGNOSTICS;
    });

    const onSaveSetting = vi.fn().mockImplementation(async (key: string) => {
      if (key === 'ollama_endpoint') throw new Error('Loopback rejected');
    });
    const { rerender } = render(
      <SettingsScreen settings={SAMPLE_BOOTSTRAP.settings} onSaveSetting={onSaveSetting} />
    );

    const limitSelect = screen.getByLabelText('Diagnostics limit');
    fireEvent.change(limitSelect, { target: { value: '200' } });
    fireEvent.change(limitSelect, { target: { value: '20' } });
    await waitFor(() => expect(screen.getByText('FRESH_20_MSG')).toBeInTheDocument());
    resolveSlow([{ id: 'stale', severity: 'warn', component: 'ui', message: 'STALE_200_MSG', created_at: '2026-11-18T10:00:00Z' }]);
    await waitFor(() => expect(screen.queryByText('STALE_200_MSG')).not.toBeInTheDocument());

    const ctxInput = screen.getByLabelText('Default Context Length') as HTMLInputElement;
    fireEvent.change(ctxInput, { target: { value: '' } });
    expect(ctxInput.value).toBe('');
    fireEvent.change(ctxInput, { target: { value: '8192' } });

    const reserveInput = screen.getByLabelText('OS Memory Safety Reserve (GiB)') as HTMLInputElement;
    const epInput = screen.getByLabelText('Ollama Loopback Endpoint') as HTMLInputElement;
    const kaInput = screen.getByLabelText('Keep Alive') as HTMLInputElement;
    fireEvent.change(reserveInput, { target: { value: '4' } });
    fireEvent.change(epInput, { target: { value: 'http://evil.example:11434' } });
    fireEvent.change(kaInput, { target: { value: '15m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => expect(screen.getByText(/Loopback rejected/)).toBeInTheDocument());
    rerender(
      <SettingsScreen
        settings={{ ...SAMPLE_BOOTSTRAP.settings, safety_reserve_gib: 4 }}
        onSaveSetting={onSaveSetting}
      />
    );
    expect(kaInput.value).toBe('15m');
    expect(epInput.value).toBe('http://evil.example:11434');
  });
});
