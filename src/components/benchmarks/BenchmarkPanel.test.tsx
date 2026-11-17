import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BenchmarkPanel } from './BenchmarkPanel';

describe('BenchmarkPanel', () => {
  it('renders measured benchmark metrics and export buttons', () => {
    const onExport = vi.fn();
    render(
      <BenchmarkPanel
        benchmarkingModel={null}
        onExport={onExport}
        reports={[
          {
            id: 'rep-1',
            model_name: 'mistral:7b-instruct-q4_K_M',
            context_length: 4096,
            storage_media_kind: 'HDD',
            cold_load_ms: 115910.67,
            warm_load_ms: 0.67,
            ttft_median_ms: 123.6,
            tok_per_sec_median: 19.65,
            peak_ram_bytes: 9_618_669_568,
            repetitions: 2,
            raw_report_json: '{}',
            created_at: '2026-11-17T05:10:23Z',
          },
        ]}
      />
    );

    expect(screen.getByText('19.65 tok/s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
    expect(onExport).toHaveBeenCalledWith('rep-1', 'csv');
  });
});
