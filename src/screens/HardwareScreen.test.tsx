import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_BOOTSTRAP } from '../test-utils/mockFixtures';
import { installTauriTestBridge, type TauriTestController } from '../test-utils/mockTauri';
import { HardwareScreen } from './HardwareScreen';

describe('HardwareScreen', () => {
  let tauri: TauriTestController;

  beforeEach(() => {
    tauri = installTauriTestBridge();
  });

  afterEach(() => {
    tauri.uninstall();
  });

  it('displays Accelerator, GPU VRAM, gpus, Metal wired limit, and loads analyze_hardware_insights report', async () => {
    render(<HardwareScreen state={SAMPLE_BOOTSTRAP} />);

    expect(screen.getByText('Metal Wired Limit')).toBeInTheDocument();
    expect(screen.getByText('Apple Silicon Unified Metal')).toBeInTheDocument();
    expect(screen.getByText('GPU VRAM')).toBeInTheDocument();
    expect(screen.getByText('Apple Apple M3 GPU')).toBeInTheDocument();
    expect(screen.getByText('macos_app_or_cli')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Analyze Hardware Insights/i }));
    await waitFor(() => {
      expect(screen.getByText('Effective Available RAM')).toBeInTheDocument();
      expect(screen.getByText(/ExFAT drive increases initial cold load latency/i)).toBeInTheDocument();
    });
    expect(tauri.callsFor('analyze_hardware_insights')).toHaveLength(1);
  });

  it('renders discrete GPU name and VRAM directly in Hardware & Memory Profile', () => {
    render(
      <HardwareScreen
        state={{
          ...SAMPLE_BOOTSTRAP,
          system: {
            ...SAMPLE_BOOTSTRAP.system,
            is_unified_memory: false,
            metal_wired_limit_bytes: null,
            gpu_status: 'Discrete NVIDIA CUDA',
            gpu_vram_bytes: 4 * 1024 ** 3,
            gpus: [
              { vendor: 'NVIDIA', model: 'RTX 3050 Laptop', vram_bytes: 4 * 1024 ** 3, unified_memory: false, source: 'nvidia-smi' },
            ],
          },
        }}
      />
    );

    expect(screen.getByText('Discrete NVIDIA CUDA')).toBeInTheDocument();
    expect(screen.getByText('NVIDIA RTX 3050 Laptop')).toBeInTheDocument();
    expect(screen.getAllByText(/4\.0 GiB/)).toHaveLength(2);
  });
});
