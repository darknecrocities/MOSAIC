import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { SAMPLE_BOOTSTRAP } from './test-utils/mockFixtures';
import { installTauriTestBridge } from './test-utils/mockTauri';

describe('App Milestone shell and route orchestration', () => {
  it('renders 7 navigation routes and external-drive onboarding gate in browser preview', () => {
    render(<App />);
    expect(screen.getByText('MOSAIC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover Models' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My Models' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Model' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hardware' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'External Storage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(
      screen.getAllByText(/internal disk fallback is disabled/i).length
    ).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole('button', { name: 'Discover Models' }));
    expect(screen.getByRole('heading', { name: 'Discover Models' })).toBeInTheDocument();
  });

  it('renders OnboardingGate only once on External Storage when library is disconnected', async () => {
    const tauri = installTauriTestBridge({
      get_app_state: () => ({
        ...SAMPLE_BOOTSTRAP,
        active_library: null,
        library_connected: false,
      }),
    });
    try {
      const { unmount } = render(<App />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Connect & Select Your External Model Library/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'External Storage' }));
      expect(screen.getAllByRole('heading', { name: /Connect & Select Your External Model Library/i })).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Discover Models' }));
      unmount();
    } finally {
      tauri.uninstall();
    }
  });
});
