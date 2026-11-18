import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_BOOTSTRAP } from '../test-utils/mockFixtures';
import { OverviewScreen } from './OverviewScreen';

describe('OverviewScreen', () => {
  it('renders 3-column workstation summary and navigates to hardware, storage, and run/discover', () => {
    const onNavigate = vi.fn();
    render(<OverviewScreen state={SAMPLE_BOOTSTRAP} installedCount={2} onNavigate={onNavigate} />);

    expect(screen.getByText('Host Hardware')).toBeInTheDocument();
    expect(screen.getByText('External Model Library')).toBeInTheDocument();
    expect(screen.getByText('Runtime & Models')).toBeInTheDocument();
    expect(screen.getByText('Apple Silicon Unified Metal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /View Hardware Diagnostics/i }));
    fireEvent.click(screen.getByRole('button', { name: /Manage External Storage/i }));
    fireEvent.click(screen.getByRole('button', { name: /Launch Chat/i }));

    expect(onNavigate).toHaveBeenNthCalledWith(1, 'hardware');
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'storage');
    expect(onNavigate).toHaveBeenNthCalledWith(3, 'run');
  });
});
