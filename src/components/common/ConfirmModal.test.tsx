import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SAMPLE_SHOW_DETAILS } from '../../test-utils/mockFixtures';
import { ConfirmModal } from './ConfirmModal';
import { ModelShowModal } from '../models/ModelShowModal';

function ModalFocusHarness({ mode }: { mode: 'confirm' | 'show' }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open Dialog</button>
      {mode === 'confirm' ? (
        <ConfirmModal
          open={open}
          title="Confirm Action"
          description="Proceed with action?"
          confirmLabel="Confirm"
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      ) : (
        <ModelShowModal
          open={open}
          modelName="qwen3:30b-a3b"
          loading={false}
          error={null}
          details={SAMPLE_SHOW_DETAILS}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

describe('Dialog Accessibility (ConfirmModal & ModelShowModal)', () => {
  it('enters focus on open, dismisses via Escape or backdrop, and restores focus to trigger', async () => {
    render(<ModalFocusHarness mode="confirm" />);
    const trigger = screen.getByRole('button', { name: 'Open Dialog' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    const buttons = Array.from(dialog.querySelectorAll('button'));
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);

    const modalBox = dialog.firstElementChild as HTMLElement;
    modalBox.focus();
    expect(document.activeElement).toBe(modalBox);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('dialog'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it('traps and restores focus for ModelShowModal', async () => {
    render(<ModalFocusHarness mode="show" />);
    const trigger = screen.getByRole('button', { name: 'Open Dialog' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });
});
