import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_REPORTS } from '../../test-utils/mockFixtures';
import { installTauriTestBridge } from '../../test-utils/mockTauri';
import { BenchmarkPanel } from './BenchmarkPanel';

describe('BenchmarkPanel', () => {
  it('renders measured benchmark metrics, export buttons, and bottleneck analysis', async () => {
    const tauri = installTauriTestBridge();
    const onExport = vi.fn();

    try {
      render(
        <BenchmarkPanel
          benchmarkingModel={null}
          onExport={onExport}
          reports={SAMPLE_REPORTS}
        />
      );

      expect(screen.getByText('18.4 tok/s')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
      expect(onExport).toHaveBeenCalledWith('rep-1', 'csv');

      fireEvent.click(screen.getByRole('button', { name: /Analyze Bottlenecks/i }));
      await waitFor(() => {
        expect(screen.getByText(/Warm generation is compute-bound/i)).toBeInTheDocument();
      });
      expect(tauri.callsFor('analyze_benchmark_performance')[0]?.args).toEqual({ reportId: 'rep-1' });
    } finally {
      tauri.uninstall();
    }
  });
});
