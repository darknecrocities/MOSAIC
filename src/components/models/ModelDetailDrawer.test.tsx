import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_CATALOG, SAMPLE_CLUSTER_PLAN } from '../../test-utils/mockFixtures';
import { installTauriTestBridge, type TauriTestController } from '../../test-utils/mockTauri';
import { ModelDetailDrawer } from './ModelDetailDrawer';

describe('ModelDetailDrawer', () => {
  let tauri: TauriTestController;

  beforeEach(() => {
    tauri = installTauriTestBridge();
  });

  afterEach(() => {
    tauri.uninstall();
  });

  it('closes only stacked ConfirmModal on first Escape and keeps drawer open until second Escape', async () => {
    const onClose = vi.fn();
    render(
      <ModelDetailDrawer
        item={SAMPLE_CATALOG[1]}
        libraryConnected={true}
        freeBytes={500 * 1024 ** 3}
        onPullModel={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Adaptive Pull/i }));
    expect(screen.getByRole('heading', { name: 'Pull Exceeds Safe Memory Budget' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Pull Exceeds Safe Memory Budget' })).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'DeepSeek-R1 70B' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards stacked Escape for ClusterPlanPanel Launch Runtime ConfirmModal and resets stale notices', async () => {
    const onClose = vi.fn();
    render(
      <ModelDetailDrawer
        item={SAMPLE_CATALOG[1]}
        libraryConnected={true}
        freeBytes={500 * 1024 ** 3}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Compute Adaptive \/ Cluster Plan/i }));
    await waitFor(() => expect(screen.getByText('multi_node_rpc')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/GGUF relative path/i), {
      target: { value: 'models/deepseek.gguf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Launch Cluster Runtime/i }));
    expect(screen.getByRole('heading', { name: 'Launch Experimental Cluster Runtime' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Launch Experimental Cluster Runtime' })).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores stale plan_adaptive_execution response across model switches and renders 0.0 GiB budgets', async () => {
    let resolveFirst!: (val: unknown) => void;
    tauri.setHandler('plan_adaptive_execution', () => new Promise((r) => { resolveFirst = r; }));

    const zeroBudgetItem = {
      ...SAMPLE_CATALOG[1],
      fit: { ...SAMPLE_CATALOG[1].fit, available_budget: 0, kv_cache_estimate: 0 },
    };

    const { rerender } = render(
      <ModelDetailDrawer item={SAMPLE_CATALOG[0]} libraryConnected={true} onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Compute Adaptive \/ Cluster Plan/i }));
    await waitFor(() => expect(typeof resolveFirst).toBe('function'));

    rerender(<ModelDetailDrawer item={zeroBudgetItem} libraryConnected={true} onClose={vi.fn()} />);
    expect(screen.getAllByText('0.0 GiB').length).toBeGreaterThanOrEqual(2);

    resolveFirst({ ...SAMPLE_CLUSTER_PLAN, strategy: 'STALE_MODEL_A_STRATEGY' });
    await waitFor(() => {
      expect(screen.queryByText('STALE_MODEL_A_STRATEGY')).not.toBeInTheDocument();
    });
  });
});
