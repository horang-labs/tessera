'use client';

import { useI18n } from '@/lib/i18n';

interface LoadingIndicatorProps {
  isVisible: boolean;
}

export function LoadingIndicator({ isVisible }: LoadingIndicatorProps) {
  const { t } = useI18n();

  if (!isVisible) return null;

  return (
    <div className="flex items-center gap-3 text-(--text-muted)">
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-(--accent-light) rounded-full animate-typing" />
        <span className="w-2 h-2 bg-(--accent-light) rounded-full animate-typing" style={{ animationDelay: '0.2s' }} />
        <span className="w-2 h-2 bg-(--accent-light) rounded-full animate-typing" style={{ animationDelay: '0.4s' }} />
      </div>
      <span className="text-sm">{t('thinking.label')}</span>
    </div>
  );
}
