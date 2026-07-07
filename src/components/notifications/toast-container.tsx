'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useNotificationStore, type ActionToast } from '@/stores/notification-store';
import { toast } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import { useTabStore } from '@/stores/tab-store';
import { useSessionStore } from '@/stores/session-store';
import { useBoardStore } from '@/stores/board-store';
import { ToastNotification } from './toast-notification';
import { NotificationSound } from './notification-sound';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { wsClient } from '@/lib/ws/client';
import { cn } from '@/lib/utils';
import { activateSessionPanel } from '@/lib/session/focus-session-panel';

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
        'w-[320px] rounded-lg border border-(--toast-border)',
        'bg-(--toast-bg) hover:bg-(--toast-bg-hover) transition-colors',
        'flex items-center gap-2.5 p-3',
      )}
      style={{ boxShadow: 'var(--toast-shadow)' }}
      role="status"
    >
      <div className="w-5 h-5 rounded-md bg-(--toast-icon-bg) border border-(--toast-icon-border) flex items-center justify-center shrink-0">
        <Icon className="w-3 h-3" style={{ color }} />
      </div>
      <span className="text-[13px] font-medium text-(--text-primary) flex-1 min-w-0 truncate">{toastItem.message}</span>
      {toastItem.action && (
        <button
          onClick={(e) => { e.stopPropagation(); toastItem.action!.onClick(); onDismissRef.current(); }}
          className="shrink-0 text-[12px] font-medium text-(--accent) hover:underline"
        >
          {toastItem.action.label}
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDismissRef.current(); }}
        className="shrink-0 p-0.5 rounded text-(--toast-muted) hover:text-(--text-primary) hover:bg-(--toast-icon-bg) transition-colors"
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
  const clearUnreadCount = useSessionStore((s) => s.clearUnreadCount);
  const getSession = useSessionStore((s) => s.getSession);
  const { viewSession } = useSessionNavigation();

  const visibleNotifications = notifications
    .filter((n) => !n.dismissed)
    .slice(0, MAX_VISIBLE_TOASTS);

  const handleClick = async (notificationId: string, sessionId: string) => {
    markAsRead(notificationId);
    dismissToast(notificationId);

    const session = getSession(sessionId);
    if (!session) {
      toast.error(t('errors.sessionNotFound'));
      return;
    }

    clearUnreadCount(sessionId);
    wsClient.sendMarkAsRead(sessionId);

    // Switch to the session's project if different from current
    const currentProjectDir = useBoardStore.getState().selectedProjectDir;
    if (session.projectDir && session.projectDir !== currentProjectDir) {
      useBoardStore.getState().setSelectedProjectDir(session.projectDir);
      useTabStore.getState().switchProject(session.projectDir);
    }

    // Tab-aware session focus: use findSessionLocation (same as sidebar click handler)
    const tabStore = useTabStore.getState();
    const location = tabStore.findSessionLocation(sessionId);

    if (location) {
      // Session already open — switch to correct tab and focus panel
      activateSessionPanel(sessionId, { location });
      return;
    }

    // Session not in any tab/panel: load it in the active panel
    try {
      await viewSession(session);
    } catch {
      toast.error(t('errors.sessionLoadFailed'));
    }
  };

  return (
    <>
      <NotificationSound />
      <div
        className="flex flex-col-reverse gap-2.5 pointer-events-none"
        style={{ position: 'fixed', bottom: '1.25rem', left: '3.75rem', zIndex: 9999 }}
      >
        <AnimatePresence>
          {/* Action toasts (simple success/error/warning) */}
          {actionToasts.map((t) => (
            <div key={t.id} className="pointer-events-auto">
              <ActionToastItem t={t} onDismiss={() => dismissActionToast(t.id)} />
            </div>
          ))}
          {/* Session notifications (completed/input_required) */}
          {visibleNotifications.map((n) => (
            <div key={n.id} className="pointer-events-auto">
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
