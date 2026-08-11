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
import { useSettingsStore } from '@/stores/settings-store';
import { getRenderedViewMode } from '@/lib/viewport/rendered-view-mode';
import { ToastNotification, TOAST_DISMISS_TOUCH_TARGET } from './toast-notification';
import { NotificationSound } from './notification-sound';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { wsClient } from '@/lib/ws/client';
import { cn } from '@/lib/utils';
import { activateSessionPanel } from '@/lib/session/focus-session-panel';
import { switchToSessionProject } from '@/lib/session/switch-session-project';
import { getSessionOriginProjectId } from '@/lib/projects/origin-project-representation';
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
          onClick={(e) => { e.stopPropagation(); toastItem.action!.onClick(); onDismissRef.current(); }}
          className="shrink-0 text-[0.625rem] font-medium text-(--accent) hover:underline"
        >
          {toastItem.action.label}
        </button>
      )}
      <button
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

    // Notified session may live in another project — bring that project into scope first,
    // otherwise it opens in a tab belonging to the project currently on screen.
    if (!switchToSessionProject(getSessionOriginProjectId(session))) return;

    // Kanban peek mode: open the session in the board peek panel instead of a tab
    const boardStore = useBoardStore.getState();
    const peekMode = useSettingsStore.getState().settings.kanbanSessionOpenMode === 'peek';
    // The rendered mode, not the stored one: a phone shows the list, so a peek
    // opened here would have nothing rendering it and the tap would do nothing.
    if (getRenderedViewMode() === 'board' && peekMode) {
      boardStore.openSessionPeek(sessionId);
      return;
    }

    // Tab-aware session focus: use findSessionLocation (same as sidebar click handler)
    const tabStore = useTabStore.getState();
    const location = tabStore.findSessionLocation(sessionId);

    if (location) {
      // Session already open — switch to correct tab and focus panel
      activateSessionPanel(sessionId, { location });
      return;
    }

    // Session not in any tab/panel: choose its surface synchronously, before
    // history I/O. Completion of an older load must never overwrite a newer
    // tab or panel selection.
    tabStore.openPreview(sessionId);
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
