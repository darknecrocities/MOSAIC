import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverModelsScreen } from './DiscoverModelsScreen';
import { SAMPLE_CATALOG } from '../test-utils/mockFixtures';

describe('DiscoverModelsScreen', () => {
  it('disables download when external drive is disconnected and omits one-click download for Not recommended', () => {
    render(
      <DiscoverModelsScreen
        items={SAMPLE_CATALOG}
        loading={false}
        contextLength={32768}
        libraryConnected={false}
        freeBytes={0}
        pullingName={null}
        onChangeContextLength={vi.fn()}
        onPullModel={vi.fn()}
      />
    );

    const downloadButtons = screen.getAllByRole('button', { name: /Download/i });
    expect(downloadButtons).toHaveLength(1);
    expect(downloadButtons[0]).toBeDisabled();

    const detailButtons = screen.getAllByRole('button', { name: /View details/i });
    fireEvent.click(detailButtons[0]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Adaptive Execution Plan/i)).toBeInTheDocument();
  });

  it('wires profile/KV/context/refresh controls and ConfirmModal-gated Adaptive Pull in drawer', () => {
    const onChangeCtx = vi.fn();
    const onChangeProfile = vi.fn();
    const onChangeKv = vi.fn();
    const onRefreshCatalog = vi.fn();
    const onPullModel = vi.fn();

    render(
      <DiscoverModelsScreen
        items={SAMPLE_CATALOG}
        loading={false}
        contextLength={32768}
        executionProfile="auto_adaptive"
        kvCacheType="auto"
        libraryConnected={true}
        freeBytes={500 * 1024 ** 3}
        pullingName={null}
        onChangeContextLength={onChangeCtx}
        onChangeExecutionProfile={onChangeProfile}
        onChangeKvCacheType={onChangeKv}
        onRefreshCatalog={onRefreshCatalog}
        onPullModel={onPullModel}
      />
    );

    fireEvent.change(screen.getByLabelText('Assumed context length'), { target: { value: '16384' } });
    fireEvent.change(screen.getByLabelText('Execution profile'), { target: { value: 'constrained_memory' } });
    fireEvent.change(screen.getByLabelText('KV cache'), { target: { value: 'q4_0' } });
    fireEvent.click(screen.getByRole('button', { name: /Refresh Catalog/i }));

    expect(onChangeCtx).toHaveBeenCalledWith(16384);
    expect(onChangeProfile).toHaveBeenCalledWith('constrained_memory');
    expect(onChangeKv).toHaveBeenCalledWith('q4_0');
    expect(onRefreshCatalog).toHaveBeenCalledTimes(1);

    const detailButtons = screen.getAllByRole('button', { name: /View details/i });
    fireEvent.click(detailButtons[1]);
    fireEvent.click(screen.getByRole('button', { name: /Adaptive Pull/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Download Anyway' }));
    expect(onPullModel).toHaveBeenCalledWith('deepseek-r1:70b');
  });

  it('keeps open ModelDetailDrawer synced when catalog items update and portals ConfirmModal to document.body', () => {
    const props = {
      items: SAMPLE_CATALOG,
      loading: false,
      contextLength: 32768,
      libraryConnected: true,
      freeBytes: 500 * 1024 ** 3,
      pullingName: null,
      onChangeContextLength: vi.fn(),
      onPullModel: vi.fn(),
    };

    const { rerender } = render(<DiscoverModelsScreen {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: /View details/i })[0]);
    expect(screen.getByText('KV Cache (32768 ctx)')).toBeInTheDocument();

    const updated = SAMPLE_CATALOG.map((entry, idx) =>
      idx === 0 && entry.fit.execution_plan
        ? {
            ...entry,
            fit: {
              ...entry.fit,
              context_length: 8192,
              execution_plan: { ...entry.fit.execution_plan, num_ctx: 8192 },
            },
          }
        : entry
    );
    rerender(<DiscoverModelsScreen {...props} items={updated} contextLength={8192} />);
    expect(screen.getByText('KV Cache (8192 ctx)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close model details' }));
    fireEvent.click(screen.getAllByRole('button', { name: /View details/i })[1]);
    fireEvent.click(screen.getByRole('button', { name: /Adaptive Pull/i }));
    const confirmDialog = screen.getByRole('heading', { name: 'Pull Exceeds Safe Memory Budget' }).closest('.mosaic-modal-backdrop');
    expect(confirmDialog?.parentElement).toBe(document.body);
  });
});
