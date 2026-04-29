'use client';

import type { ComponentType, ReactNode } from 'react';
import { X as XIcon } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';

interface ModalShellProps {
  title: string;
  titleId: string;
  icon: ComponentType<{ className?: string }>;
  subtitle?: string;
  onClose: () => void;
  overlayTestId: string;
  dialogTestId: string;
  closeTestId: string;
  children: ReactNode;
  footer: ReactNode;
  panelClassName?: string;
}

export function ModalShell({
  title,
  titleId,
  icon: Icon,
  subtitle,
  onClose,
  overlayTestId,
  dialogTestId,
  closeTestId,
  children,
  footer,
  panelClassName,
}: ModalShellProps) {
  const { t } = useI18n();

  useCloseOnEscape(onClose);

  function handleOverlayClick(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={handleOverlayClick}
      data-testid={overlayTestId}
    >
      <div
        className={cn(
          'mx-4 w-full max-w-sm overflow-hidden rounded-xl border border-(--divider) bg-(--sidebar-bg) shadow-2xl',
          panelClassName,
        )}
        data-testid={dialogTestId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex items-center justify-between border-b border-(--divider) px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-(--accent)" />
            <div>
              <h3
                id={titleId}
                className="text-sm font-semibold text-(--sidebar-text-active)"
              >
                {title}
              </h3>
              {subtitle ? (
                <p className="mt-0.5 text-xs text-(--text-muted)">
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--sidebar-text)"
            aria-label={t('common.close')}
            data-testid={closeTestId}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-4">
          {children}
        </div>

        <div className="flex justify-end gap-2 border-t border-(--divider) px-4 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}
