import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_CLUSTER_PLAN } from '../../test-utils/mockFixtures';
import { installTauriTestBridge, type TauriTestController } from '../../test-utils/mockTauri';
import { ClusterPlanPanel } from './ClusterPlanPanel';

describe('ClusterPlanPanel', () => {
  let tauri: TauriTestController;

  beforeEach(() => {
    tauri = installTauriTestBridge();
  });

  afterEach(() => {
    tauri.uninstall();
  });

  it('renders 3-tier memory breakdown, MoE/RPC flags, and gates Phase 7 cluster launch/stop', async () => {
    render(<ClusterPlanPanel plan={SAMPLE_CLUSTER_PLAN} />);

    expect(screen.getByText('multi_node_rpc')).toBeInTheDocument();
    expect(screen.getByText('Pooled RPC Nodes')).toBeInTheDocument();
    expect(screen.getByText(/exps=CPU/)).toBeInTheDocument();

    const launchBtn = screen.getByRole('button', { name: /Launch Cluster Runtime/i });
    expect(launchBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/GGUF relative path/i), {
      target: { value: 'models/qwen3-30b.gguf' },
    });
    expect(launchBtn).toBeEnabled();

    fireEvent.click(launchBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Launch Runtime' }));
    await waitFor(() => {
      expect(tauri.callsFor('launch_cluster_runtime')[0]?.args).toEqual({
        ggufRelPath: 'models/qwen3-30b.gguf',
        runtimeFlags: SAMPLE_CLUSTER_PLAN.runtime_flags,
        confirmed: true,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /Stop Cluster Runtime/i }));
    await waitFor(() => {
      expect(tauri.callsFor('stop_cluster_runtime')).toHaveLength(1);
    });
  });

  it('shows inline validation warning on invalid paths while still surfacing backend errors through ConfirmModal', async () => {
    tauri.setHandler('launch_cluster_runtime', () => {
      throw new Error('InvalidPath: Cluster runtime model path must have a .gguf extension.');
    });

    render(<ClusterPlanPanel plan={SAMPLE_CLUSTER_PLAN} />);
    const pathInput = screen.getByLabelText(/GGUF relative path/i);
    const launchBtn = screen.getByRole('button', { name: /Launch Cluster Runtime/i });

    for (const invalid of ['../escape.gguf', '._hidden.gguf', '.gguf', '/etc/escape.gguf']) {
      fireEvent.change(pathInput, { target: { value: invalid } });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(launchBtn).toBeEnabled();
    }

    fireEvent.change(pathInput, { target: { value: 'models/bad.bin' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/\.gguf/i);
    expect(launchBtn).toBeEnabled();

    fireEvent.click(launchBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Launch Runtime' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/InvalidPath: .*\.gguf/i);
    });
  });
});
