'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { MessageRowShell } from './message-row-shell';

interface WaitingIndicatorProps {
  providerId?: string;
}

/** Waiting indicator — shown in gaps between blocks during an active turn.
 *  Rendered without provider chrome (icon + label) so consecutive
 *  thinking → waiting visuals don't repeat the "Claude"/"Codex" header. */
export function WaitingIndicator({ providerId: _providerId }: WaitingIndicatorProps) {
  const { t } = useI18n();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (s: number) => {
    if (s < 60) return t('time.seconds', { s });
    return t('time.minutesAndSeconds', { m: Math.floor(s / 60), s: s % 60 });
  };

  return (
    <MessageRowShell
      className="flex gap-3 py-2 px-2 message-enter"
      data-testid="waiting-indicator"
    >
      <div className="shrink-0 w-8" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm text-(--text-muted)">
          <div className="flex gap-1">
            <span className="typing-dot w-1.5 h-1.5 bg-(--accent) rounded-full" />
            <span className="typing-dot w-1.5 h-1.5 bg-(--accent) rounded-full" />
            <span className="typing-dot w-1.5 h-1.5 bg-(--accent) rounded-full" />
          </div>
          <span className="text-xs">
            {t('chat.working')}{elapsed > 0 && ` · ${formatTime(elapsed)}`}
          </span>
        </div>
      </div>
    </MessageRowShell>
  );
}
