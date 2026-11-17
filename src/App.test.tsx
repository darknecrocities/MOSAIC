import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App Milestone B shell', () => {
  it('renders 7 navigation routes and external-drive onboarding gate', () => {
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
});
