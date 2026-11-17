import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingGate } from './OnboardingGate';

describe('OnboardingGate', () => {
  it('blocks selection when no external volumes exist and allows hardware inspection', () => {
    const onInspectHardware = vi.fn();
    render(
      <OnboardingGate
        volumes={[]}
        selecting={false}
        onSelectVolume={vi.fn()}
        onInspectHardware={onInspectHardware}
      />
    );

    expect(screen.getByText(/No eligible external drive detected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Inspect Hardware Profile/i }));
    expect(onInspectHardware).toHaveBeenCalledTimes(1);
  });

  it('disables read-only volumes and allows selecting writable external SSD', () => {
    const onSelectVolume = vi.fn();
    render(
      <OnboardingGate
        volumes={[
          {
            volume_identifier: 'RO-1',
            label: 'ReadOnlyDrive',
            mount_path: '/Volumes/RO',
            filesystem: 'NTFS',
            protocol: 'USB',
            media_kind: 'HDD',
            total_bytes: 100 * 1024 ** 3,
            free_bytes: 50 * 1024 ** 3,
            writable: false,
            advisory: 'Volume is mounted read-only.',
          },
          {
            volume_identifier: 'SSD-1',
            label: 'MosaicSSD',
            mount_path: '/Volumes/MosaicSSD',
            filesystem: 'APFS',
            protocol: 'USB',
            media_kind: 'SSD',
            total_bytes: 500 * 1024 ** 3,
            free_bytes: 400 * 1024 ** 3,
            writable: true,
            advisory: null,
          },
        ]}
        selecting={false}
        onSelectVolume={onSelectVolume}
        onInspectHardware={vi.fn()}
      />
    );

    const buttons = screen.getAllByRole('button', { name: /Use as MOSAIC Library/i });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
    fireEvent.click(buttons[1]);
    expect(onSelectVolume).toHaveBeenCalledWith('SSD-1');
  });
});
