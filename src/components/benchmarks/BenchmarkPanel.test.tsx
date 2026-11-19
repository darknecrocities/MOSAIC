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

  it('formats python category/severity/explanation bottlenecks without raw JSON', async () => {
    const tauri = installTauriTestBridge({
      analyze_benchmark_performance: () => ({
        bottlenecks: [
          {
            category: 'storage_throughput',
            severity: 'high',
            explanation: 'Cold model load (34.2s) indicates slow external storage I/O.',
          },
        ],
        efficiency_ratios: { cold_to_warm_load_ratio: 185.0 },
        recommendations: ['Use an NVMe SSD or keep warm keep_alive.'],
        summary: 'Identified 1 potential constraint(s).',
      }),
    });
    const onExport = vi.fn();

    try {
      render(
        <BenchmarkPanel
          benchmarkingModel={null}
          onExport={onExport}
          reports={SAMPLE_REPORTS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /Analyze Bottlenecks/i }));
      await waitFor(() => {
        expect(
          screen.getByText(/storage_throughput \(high\): Cold model load \(34\.2s\)/i)
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/\{.*"category"/)).not.toBeInTheDocument();
    } finally {
      tauri.uninstall();
    }
  });

  it('omits null/undefined efficiency ratios instead of rendering literal null', async () => {
    const tauri = installTauriTestBridge({
      analyze_benchmark_performance: () => ({
        bottlenecks: [],
        efficiency_ratios: {
          cold_to_warm_load_ratio: 1.0,
          memory_utilization_ratio: 0.73,
          offload_ratio: null,
        },
        recommendations: [],
        summary: 'No major hardware bottlenecks detected.',
      }),
    });

    try {
      render(
        <BenchmarkPanel
          benchmarkingModel={null}
          onExport={vi.fn()}
          reports={SAMPLE_REPORTS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /Analyze Bottlenecks/i }));
      await waitFor(() => {
        expect(screen.getByText('0.73')).toBeInTheDocument();
      });
      expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
      expect(screen.queryByText('offload_ratio')).not.toBeInTheDocument();
    } finally {
      tauri.uninstall();
    }
  });
});
