import { X } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div
      className="mosaic-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="mosaic-modal">
        <div className="mosaic-panel-header">
          <h2 id="confirm-modal-title">{title}</h2>
          <button
            type="button"
            className="mosaic-button-secondary"
            onClick={onCancel}
            aria-label="Close confirmation dialog"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="mosaic-subtitle">{description}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="mosaic-button-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="mosaic-button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
