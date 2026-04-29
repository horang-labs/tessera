'use client';

import { useState, type ComponentType, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { DialogHero } from '@/components/ui/dialog-hero';
import { cn } from '@/lib/utils';

interface AsyncConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: ReactNode;
  icon: ComponentType<{ className?: string }>;
  cancelLabel: string;
  confirmLabel: string;
  confirmingLabel?: string;
  iconContainerClassName?: string;
  iconClassName?: string;
  confirmButtonClassName?: string;
  dialogTestId?: string;
  cancelTestId?: string;
  confirmTestId?: string;
  errorLogLabel?: string;
}

export function AsyncConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  icon,
  cancelLabel,
  confirmLabel,
  confirmingLabel,
  iconContainerClassName,
  iconClassName,
  confirmButtonClassName,
  dialogTestId,
  cancelTestId,
  confirmTestId,
  errorLogLabel = 'Confirm dialog error:',
}: AsyncConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  // Dialog closed → submitting is always false; no useEffect needed.
  const isSubmitting = open && submitting;

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (error) {
      console.error(errorLogLabel, error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent data-testid={dialogTestId}>
        <DialogHeader>
          <DialogHero
            title={title}
            icon={icon}
            iconContainerClassName={iconContainerClassName}
            iconClassName={iconClassName}
          />
        </DialogHeader>

        <div className="mb-6 mt-4">
          {description}
        </div>

        <div className="flex justify-end gap-3">
          <Button
            onClick={onCancel}
            disabled={isSubmitting}
            variant="outline"
            data-testid={cancelTestId}
          >
            {cancelLabel}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSubmitting}
            className={cn(confirmButtonClassName)}
            data-testid={confirmTestId}
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isSubmitting ? (confirmingLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
