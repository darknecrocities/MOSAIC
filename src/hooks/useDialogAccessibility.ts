import { useEffect, useRef, type RefObject } from 'react';

const openDialogStack: symbol[] = [];

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
  );
}

interface UseDialogAccessibilityArgs {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function useDialogAccessibility({ open, dialogRef, onClose }: UseDialogAccessibilityArgs) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = Symbol('mosaic-dialog');
    openDialogStack.push(token);
    const previousFocus =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    const container = dialogRef.current;
    if (container && typeof document !== 'undefined' && !container.contains(document.activeElement)) {
      const focusables = getFocusableElements(container);
      const target = focusables[0] ?? container;
      target.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (openDialogStack[openDialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = getFocusableElements(dialogRef.current);
        if (focusables.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (
            !active ||
            active === dialogRef.current ||
            active === first ||
            !dialogRef.current.contains(active)
          ) {
            e.preventDefault();
            last.focus();
          }
        } else if (!active || active === last || !dialogRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      const idx = openDialogStack.lastIndexOf(token);
      if (idx !== -1) openDialogStack.splice(idx, 1);
      if (previousFocus && typeof document !== 'undefined' && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    };
  }, [open, dialogRef]);
}
