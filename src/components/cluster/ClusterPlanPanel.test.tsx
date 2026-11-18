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
});
