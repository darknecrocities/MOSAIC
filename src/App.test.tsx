import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App Milestone A shell', () => {
  it('renders MOSAIC header and external-drive guardrail message', () => {
    render(<App />);
    expect(screen.getByText('MOSAIC')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /refresh system and runtime diagnostics/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/internal disk fallback is disabled/i)
    ).toBeInTheDocument();
  });
});
