import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverModelsScreen } from './DiscoverModelsScreen';
import type { CatalogModelWithFit } from '../types/ipc';

const FIXTURE: CatalogModelWithFit[] = [
  {
    model: {
      ollama_name: 'llama3.2:1b',
      display_name: 'Llama 3.2 1B',
      provider: 'Meta',
      parameter_billions: 1.24,
      quantization: 'Q8_0',
      download_size_bytes: 1_320_000_000,
      n_layers: 16,
      n_kv_heads: 8,
      head_dim: 64,
      default_context: 4096,
      license_name: 'Llama 3.2 Community',
      license_url: 'https://ollama.com/library/llama3.2',
      summary: 'Compact instruction model.',
    },
    fit: {
      fit_status: 'Recommended',
      weight_memory_estimate: 1_360_000_000,
      runtime_overhead_estimate: 500_000_000,
      kv_cache_estimate: 134_217_728,
      total_estimated_bytes: 1_994_217_728,
      available_budget: 7_000_000_000,
      context_length: 4096,
      expected_backend: 'unified_metal',
      performance_estimate: 'Not benchmarked yet',
      reasons: ['Fits within safe budget.'],
      source: 'calculated',
      confidence: 'high',
    },
  },
  {
    model: {
      ollama_name: 'deepseek-r1:70b',
      display_name: 'DeepSeek-R1 70B',
      provider: 'DeepSeek',
      parameter_billions: 70.6,
      quantization: 'Q4_K_M',
      download_size_bytes: 42_520_000_000,
      n_layers: 80,
      n_kv_heads: 8,
      head_dim: 128,
      default_context: 4096,
      license_name: 'MIT',
      license_url: 'https://ollama.com/library/deepseek-r1',
      summary: 'Large 70B reasoning model.',
    },
    fit: {
      fit_status: 'Not recommended',
      weight_memory_estimate: 43_795_600_000,
      runtime_overhead_estimate: 3_800_000_000,
      kv_cache_estimate: 2_684_354_560,
      total_estimated_bytes: 50_279_954_560,
      available_budget: 7_000_000_000,
      context_length: 4096,
      expected_backend: 'unified_metal',
      performance_estimate: 'Not benchmarked yet',
      reasons: ['Exceeds safe budget.'],
      source: 'calculated',
      confidence: 'high',
    },
  },
];

describe('DiscoverModelsScreen', () => {
  it('disables download when external drive is disconnected and omits one-click download for Not recommended', () => {
    render(
      <DiscoverModelsScreen
        items={FIXTURE}
        loading={false}
        contextLength={4096}
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
    expect(screen.getByText('Not benchmarked yet')).toBeInTheDocument();
  });
});
