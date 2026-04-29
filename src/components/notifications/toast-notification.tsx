'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, AlertTriangle, Shield, MessageCircleQuestion, X, Loader2 } from 'lucide-react';
import { Notification } from '@/types/notification';
import { useSessionStore } from '@/stores/session-store';
import { wsClient } from '@/lib/ws/client';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { formatDistanceToNow } from 'date-fns';
import { getDateFnsLocale } from '@/lib/i18n/locale-map';
import logger from '@/lib/logger';

interface ToastNotificationProps {
  notification: Notification;
  onDismiss: () => void;
  onClick: () => void;
}

const COMPLETED_TOAST_DURATION_MS = 5000;
const INTERACTIVE_TOAST_DURATION_MS = 10000;

export function ToastNotification({ notification, onDismiss, onClick }: ToastNotificationProps) {
  const { t, language } = useI18n();
  const getSession = useSessionStore((s) => s.getSession);
  const session = getSession(notification.sessionId);

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
      useSessionStore.getState().clearUnreadCount(notification.sessionId);
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
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15 }}
      onClick={onClick}
      data-testid="toast-notification"
      className={cn(
        'w-[320px] rounded-lg border border-(--toast-border) cursor-pointer',
        'bg-(--toast-bg)',
        'hover:bg-(--toast-bg-hover) transition-colors'
      )}
      style={{ boxShadow: 'var(--toast-shadow)' }}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <div className="w-5 h-5 rounded-md bg-(--toast-icon-bg) border border-(--toast-icon-border) flex items-center justify-center shrink-0 mt-px">
            <IconComponent className="w-3 h-3" style={{ color: iconColor }} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium truncate text-(--text-primary)">
                {sessionTitle}
              </span>
              <span className="text-[11px] text-(--toast-muted) shrink-0 ml-auto">{relativeTime}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDismissRef.current(); }}
                className="p-0.5 rounded text-(--toast-muted) hover:text-(--text-primary) hover:bg-(--toast-icon-bg) transition-colors shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            <p className="text-[12px] text-(--toast-muted) leading-snug line-clamp-2 mt-0.5">
              {notification.preview}
            </p>

            {submitError && (
              <p className="text-xs text-(--error) mt-1.5">{submitError}</p>
            )}

            {hasActions && (
              <div className="flex gap-1.5 mt-2">
                {notification.actions!.map((action, i) => (
                  <button
                    key={i}
                    onClick={(e) => { e.stopPropagation(); handleActionClick(action); }}
                    disabled={isSubmitting}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors',
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
        </div>
      </div>
    </motion.div>
  );
}
