'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, AlertTriangle, Shield, MessageCircleQuestion, X, Loader2 } from 'lucide-react';
import { Notification } from '@/types/notification';
import { useNotificationStore } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
import { useProjectViewSession } from '@/hooks/use-project-view-workspace-state';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { wsClient } from '@/lib/ws/client';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { formatDistanceToNow } from 'date-fns';
import { getDateFnsLocale } from '@/lib/i18n/locale-map';
import logger from '@/lib/logger';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

interface ToastNotificationProps {
  notification: Notification;
  onDismiss: () => void;
  onClick: () => void;
}

const COMPLETED_TOAST_DURATION_MS = 5000;
const INTERACTIVE_TOAST_DURATION_MS = 10000;

/**
 * The toast that blocks a phone's input area is also the one the reporter could not
 * dismiss: a 12px icon in 2px of padding is a 16px target. `max-sm` is Phone viewport —
 * Tailwind's `sm` is 640px, and a media-query `rem` resolves against the browser's initial
 * font size, so the boundary does not move with the user's font-scale setting. Desktop
 * non-regression is structural: the rule does not exist above 640px.
 */
export const TOAST_DISMISS_TOUCH_TARGET =
  'max-sm:flex max-sm:items-center max-sm:justify-center max-sm:min-w-11 max-sm:min-h-11';

export function ToastNotification({ notification, onDismiss, onClick }: ToastNotificationProps) {
  const { t, language } = useI18n();
  const session = useProjectViewSession(notification.sessionId);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const onDismissRef = useRef(onDismiss);

  const isCompleted = notification.type === 'completed';
  const hasActions = notification.actions && notification.actions.length > 0;
  const autoDismissDelay = isCompleted
    ? COMPLETED_TOAST_DURATION_MS
    : INTERACTIVE_TOAST_DURATION_MS;

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (autoDismissDelay <= 0) {
      return;
    }

    const timer = window.setTimeout(() => onDismissRef.current(), autoDismissDelay);
    return () => window.clearTimeout(timer);
  }, [autoDismissDelay]);

  const relativeTime = formatDistanceToNow(new Date(notification.timestamp), {
    addSuffix: true,
    locale: getDateFnsLocale(language),
  });

  const sessionTitle = session?.title || `${t('notifications.sessionDefault')} ${notification.sessionId.slice(0, 8)}`;

  const handleActionClick = async (action: { label: string; value: string | number; primary?: boolean }) => {
    setIsSubmitting(true);
    setSubmitError(null);

    const sent = wsClient.sendInteractiveResponse(notification.sessionId, '', action.value.toString());
    if (sent) {
      onDismissRef.current();
      projectViewWorkspaceState.markSessionRead(notification.sessionId);
      logger.info('Interactive response sent from toast', {
        sessionId: notification.sessionId,
        action: action.value,
      });
    } else {
      logger.error('Failed to send interactive response: WebSocket not open');
      setSubmitError(t('chat.connectionErrors.networkError'));
      setIsSubmitting(false);
    }
  };

  const IconComponent = isCompleted ? CheckCircle
    : notification.type === 'ask_user_question' ? MessageCircleQuestion
    : notification.type === 'permission_request' || notification.type === 'plan_approval' ? Shield
    : AlertTriangle;

  const iconColor = isCompleted
    ? 'var(--success)'
    : notification.type === 'ask_user_question'
      ? 'var(--accent)'
      : notification.type === 'permission_request' || notification.type === 'plan_approval'
        ? 'var(--accent-light)'
        : 'var(--warning)';

  return (
    <motion.div
      {...telemetryClickAttributes('notifications.item.open', 'notifications')}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -400, transition: { duration: 0.2 } }}
      transition={{ duration: 0.15 }}
      // Horizontal swipe dismisses without triggering the card's onClick
      // (framer-motion suppresses tap when a drag actually moved).
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.6}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 80 || Math.abs(info.velocity.x) > 400) {
          onDismissRef.current();
        }
      }}
      onClick={onClick}
      data-testid="toast-notification"
      className={cn(
        'w-[15rem] max-w-full rounded-lg border border-(--toast-border) cursor-pointer',
        'bg-(--toast-bg)',
        'hover:bg-(--toast-bg-hover) transition-colors',
        'touch-pan-y',
      )}
      style={{ boxShadow: 'var(--toast-shadow)' }}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <div className="p-2 pr-1">
        <div className="flex items-start gap-2">
          <div className="w-4 h-4 rounded bg-(--toast-icon-bg) border border-(--toast-icon-border) flex items-center justify-center shrink-0 mt-px">
            <IconComponent className="w-2.5 h-2.5" style={{ color: iconColor }} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[0.6875rem] font-medium truncate text-(--text-primary)">
                {sessionTitle}
              </span>
              <span className="text-[0.625rem] text-(--toast-muted) shrink-0 ml-auto">{relativeTime}</span>
            </div>

            <p className="text-[0.625rem] text-(--toast-muted) leading-snug line-clamp-2 mt-0.5">
              {notification.preview}
            </p>

            {submitError && (
              <p className="text-xs text-(--error) mt-1.5">{submitError}</p>
            )}

            {hasActions && (
              <div className="flex gap-1.5 mt-2">
                {notification.actions!.map((action, i) => (
                  <button
                    {...telemetryClickAttributes('notifications.toast.action', 'notifications')}
                    key={i}
                    onClick={(e) => { e.stopPropagation(); handleActionClick(action); }}
                    disabled={isSubmitting}
                    className={cn(
                      'px-2 py-0.5 rounded text-[0.625rem] font-medium transition-colors',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      action.primary
                        ? 'bg-(--text-primary) text-(--toast-bg) hover:opacity-90'
                        : 'bg-(--toast-icon-bg) text-(--text-secondary) hover:bg-(--sidebar-active)'
                    )}
                  >
                    {isSubmitting && i === 0
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : action.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Dismiss lives outside the text column so it gets a full-height,
              easy-to-hit target rather than a 16px icon competing with the
              title row. Pointer events are stopped so the tap never bubbles
              to the card and navigates the user into the session. */}
          <button
            {...telemetryClickAttributes('notifications.toast.dismiss', 'notifications')}
            onClick={(e) => { e.stopPropagation(); onDismissRef.current(); }}
            onPointerDown={(e) => e.stopPropagation()}
            data-testid="toast-dismiss"
            className={cn(
              'flex items-center justify-center self-stretch shrink-0',
              'w-9 -m-2 ml-1 rounded-r-lg',
              'text-(--toast-muted) hover:text-(--text-primary)',
              'hover:bg-(--toast-icon-bg) transition-colors',
            )}
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
