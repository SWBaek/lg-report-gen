import * as Dialog from '@radix-ui/react-dialog';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '확인',
  danger = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="confirm-overlay" />
        <Dialog.Content className="confirm-content" aria-describedby="confirm-description">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description id="confirm-description">{description}</Dialog.Description>
          <div className="confirm-actions">
            <Dialog.Close asChild>
              <button className="button" onClick={onCancel}>
                취소
              </button>
            </Dialog.Close>
            <button className={`primary ${danger ? 'danger' : ''}`} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
