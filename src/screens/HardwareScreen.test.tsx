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

  it('displays Metal wired limit and loads analyze_hardware_insights report', async () => {
    render(<HardwareScreen state={SAMPLE_BOOTSTRAP} />);

    expect(screen.getByText('Metal Wired Limit')).toBeInTheDocument();
    expect(screen.getByText('macos_app_or_cli')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Analyze Hardware Insights/i }));
    await waitFor(() => {
      expect(screen.getByText('Effective Available RAM')).toBeInTheDocument();
      expect(screen.getByText(/ExFAT drive increases initial cold load latency/i)).toBeInTheDocument();
    });
    expect(tauri.callsFor('analyze_hardware_insights')).toHaveLength(1);
  });
});
