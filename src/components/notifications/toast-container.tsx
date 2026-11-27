'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useNotificationStore, type ActionToast } from '@/stores/notification-store';
import { toast } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import { ToastNotification, TOAST_DISMISS_TOUCH_TARGET } from './toast-notification';
import { NotificationSound } from './notification-sound';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { cn } from '@/lib/utils';
import { openSessionSurface } from '@/lib/session/open-session-surface';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { ANCHORED_VIEWPORT_MARGIN } from '@/lib/ui/anchored-viewport';

const MAX_VISIBLE_TOASTS = 5;
const ACTION_TOAST_DURATION = 3000;

// Simple action toast (success/error/warning/info)
function ActionToastItem({ t: toastItem, onDismiss }: { t: ActionToast; onDismiss: () => void }) {
  const { t } = useI18n();
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const duration = toastItem.action ? 5000 : ACTION_TOAST_DURATION;
    const timer = window.setTimeout(() => onDismissRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [toastItem.action]);

  const Icon = toastItem.type === 'success'
    ? CheckCircle
    : toastItem.type === 'error'
      ? XCircle
      : toastItem.type === 'info'
        ? Info
        : AlertTriangle;
  const color = toastItem.type === 'success'
    ? 'var(--success)'
    : toastItem.type === 'error'
      ? 'var(--error)'
      : toastItem.type === 'info'
        ? 'var(--accent)'
        : 'var(--warning)';

  return (
    <motion.div
      initial={{ x: -400, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -400, opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className={cn(
        'w-[17rem] max-w-full rounded-lg border border-(--toast-border)',
        'bg-(--toast-bg) hover:bg-(--toast-bg-hover) transition-colors',
        'flex items-center gap-2 p-2.5',
      )}
      style={{ boxShadow: 'var(--toast-shadow)' }}
      role="status"
    >
      <div className="w-4 h-4 rounded bg-(--toast-icon-bg) border border-(--toast-icon-border) flex items-center justify-center shrink-0">
        <Icon className="w-2.5 h-2.5" style={{ color }} />
      </div>
      <span className="text-[0.6875rem] font-medium text-(--text-primary) flex-1 min-w-0 truncate">{toastItem.message}</span>
      {toastItem.action && (
        <button
          {...telemetryClickAttributes('notifications.toast.action', 'notifications')}
          onClick={(e) => { e.stopPropagation(); toastItem.action!.onClick(); onDismissRef.current(); }}
          className="shrink-0 text-[0.625rem] font-medium text-(--accent) hover:underline"
        >
          {toastItem.action.label}
        </button>
      )}
      <button
        {...telemetryClickAttributes('notifications.toast.dismiss', 'notifications')}
        onClick={(e) => { e.stopPropagation(); onDismissRef.current(); }}
        data-testid="toast-dismiss"
        className={cn(
          'shrink-0 p-0.5 rounded text-(--toast-muted) hover:text-(--text-primary)',
          'hover:bg-(--toast-icon-bg) transition-colors',
          TOAST_DISMISS_TOUCH_TARGET,
        )}
        aria-label={t('common.close')}
      >
        <X className="w-3 h-3" />
      </button>
    </motion.div>
  );
}

export function ToastContainer() {
  const { t } = useI18n();
  const notifications = useNotificationStore((s) => s.notifications);
  const dismissToast = useNotificationStore((s) => s.dismissToast);
  const markAsRead = useNotificationStore((s) => s.markAsRead);
  const actionToasts = useNotificationStore((s) => s.toasts);
  const dismissActionToast = useNotificationStore((s) => s.dismissActionToast);
  const { materializeSession, viewSession } = useSessionNavigation();

  const visibleNotifications = notifications
    .filter((n) => !n.dismissed)
    .slice(0, MAX_VISIBLE_TOASTS);

  const handleClick = async (notificationId: string, sessionId: string) => {
    markAsRead(notificationId);
    dismissToast(notificationId);

    const result = await openSessionSurface(sessionId, { materializeSession, viewSession });
    if (result.status === 'not_found') {
      toast.error(t('errors.sessionNotFound'));
      return;
    }
    if (result.status !== 'opened' || !result.historyLoad) return;
    try {
      await result.historyLoad;
    } catch {
      toast.error(t('errors.sessionLoadFailed'));
    }
  };

  return (
    <>
      <NotificationSound />
      <div
        data-testid="toast-container"
        className={cn(
          'flex flex-col-reverse items-start gap-2.5 pointer-events-none',
          'max-sm:flex-col max-sm:!top-4 max-sm:!bottom-auto',
        )}
        style={{
          position: 'fixed',
          bottom: '1.25rem',
          left: '3.75rem',
          // The same viewport margin the anchored clamp keeps, expressed as a width bound
          // rather than a position: a toast has no anchor to be pushed away from, and both
          // its offset and its 17rem width are declared in `rem`, so at the largest font
          // preset they add up to 456px of a 360px screen. Bounding the right edge lets the
          // card shrink instead of running off. Inert on a desktop, where 17rem is far
          // inside the bound and the card keeps its declared width.
          right: ANCHORED_VIEWPORT_MARGIN,
          zIndex: 9999,
        }}
      >
        <AnimatePresence>
          {/* Action toasts (simple success/error/warning) */}
          {actionToasts.map((t) => (
            <div key={t.id} className="pointer-events-auto max-w-full">
              <ActionToastItem t={t} onDismiss={() => dismissActionToast(t.id)} />
            </div>
          ))}
          {/* Session notifications (completed/input_required) */}
          {visibleNotifications.map((n) => (
            <div key={n.id} className="pointer-events-auto max-w-full">
              <ToastNotification
                notification={n}
                onDismiss={() => dismissToast(n.id)}
                onClick={() => handleClick(n.id, n.sessionId)}
              />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
