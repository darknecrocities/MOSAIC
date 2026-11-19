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

  it('handles NaN/0 metrics, missing bottlenecks, duplicate recommendations, and concurrent per-report analysis', async () => {
    let resolveRep1!: (val: unknown) => void;
    let resolveRep2!: (val: unknown) => void;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tauri = installTauriTestBridge({
      analyze_benchmark_performance: (args) => {
        if (args.reportId === 'rep-1') return new Promise((r) => { resolveRep1 = r; });
        return new Promise((r) => { resolveRep2 = r; });
      },
    });
    const reports = [
      {
        ...SAMPLE_REPORTS[0],
        id: 'rep-1',
        tok_per_sec_median: Number.NaN,
        cold_load_ms: undefined as unknown as null,
        peak_ram_bytes: 0,
      },
      { ...SAMPLE_REPORTS[0], id: 'rep-2', model_name: 'qwen2.5:0.5b' },
    ];

    try {
      render(<BenchmarkPanel benchmarkingModel={null} onExport={vi.fn()} reports={reports} />);
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
      expect(screen.getByText(/0\.0 GiB/)).toBeInTheDocument();

      const btns = screen.getAllByRole('button', { name: /Analyze Bottlenecks/i });
      fireEvent.click(btns[0]);
      fireEvent.click(btns[1]);

      expect(screen.getAllByRole('button', { name: /Analyzing/i })).toHaveLength(2);
      await waitFor(() => expect(typeof resolveRep1).toBe('function'));
      await waitFor(() => expect(typeof resolveRep2).toBe('function'));
      resolveRep1({
        efficiency_ratios: { memory_bandwidth_utilization: 0.5 },
        recommendations: ['Duplicate tip', 'Duplicate tip'],
        summary: 'Partial report',
      });

      await waitFor(() => expect(screen.getByText('Partial report')).toBeInTheDocument());
      expect(screen.getAllByRole('button', { name: /Analyzing/i })).toHaveLength(1);
      expect(errSpy).not.toHaveBeenCalled();

      resolveRep2({ bottlenecks: [], efficiency_ratios: {}, recommendations: [], summary: 'Done 2' });
      await waitFor(() => expect(screen.getByText('Done 2')).toBeInTheDocument());
    } finally {
      errSpy.mockRestore();
      tauri.uninstall();
    }
  });
});
