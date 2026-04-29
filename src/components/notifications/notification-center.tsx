'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, AlertTriangle, Inbox } from 'lucide-react';
import { useNotificationStore } from '@/stores/notification-store';
import { useSessionStore } from '@/stores/session-store';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { useBoardStore } from '@/stores/board-store';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface NotificationCenterProps {
  isOpen: boolean;
  onClose: () => void;
  /** Bounding rect of the trigger button for fixed positioning */
  anchorRect?: DOMRect | null;
  /** Ref to the trigger button — excluded from outside-click detection */
  triggerRef?: React.RefObject<HTMLElement | null>;
  /** Dropdown open direction: 'down' (header) or 'right' (vertical strip) */
  direction?: 'down' | 'right';
}

function formatRelativeTimeFromNow(
  timestamp: string,
  now: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const diff = now - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return t('notifications.justNow');
  if (minutes < 60) return t('notifications.minutesAgo', { count: minutes });
  if (hours < 24) return t('notifications.hoursAgo', { count: hours });
  return t('notifications.daysAgo', { count: days });
}

function NotificationCenterContent({
  onClose,
  anchorRect,
  triggerRef,
  direction = 'down',
}: Omit<NotificationCenterProps, 'isOpen'>) {
  const { t } = useI18n();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const notifications = useNotificationStore((state) => state.notifications);
  const dismissAll = useNotificationStore((state) => state.dismissAll);
  const markAllAsRead = useNotificationStore((state) => state.markAllAsRead);
  const markAsRead = useNotificationStore((state) => state.markAsRead);
  const getSession = useSessionStore((state) => state.getSession);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current && !dropdownRef.current.contains(target)
        && !(triggerRef?.current && triggerRef.current.contains(target))) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose, triggerRef]);

  const handleNotificationClick = (notificationId: string, sessionId: string) => {
    markAsRead(notificationId);

    // Switch to the session's project if different from current
    const session = getSession(sessionId);
    if (session) {
      const currentProjectDir = useBoardStore.getState().selectedProjectDir;
      if (session.projectDir && session.projectDir !== currentProjectDir) {
        useBoardStore.getState().setSelectedProjectDir(session.projectDir);
        useTabStore.getState().switchProject(session.projectDir);
      }
    }

    // Tab-aware session focus: use findSessionLocation (same as sidebar click handler)
    const tabStore = useTabStore.getState();
    const location = tabStore.findSessionLocation(sessionId);

    if (location) {
      // Session already open — switch to correct tab and focus panel
      if (location.tabId !== tabStore.activeTabId) {
        tabStore.setActiveTab(location.tabId);
      }
      usePanelStore.getState().setActivePanelId(location.panelId);
    } else {
      // Session not in any tab/panel — let bridge effect assign it
      setActiveSession(sessionId);
    }

    onClose();
  };

  // Compute fixed position based on direction
  const style: React.CSSProperties = anchorRect
    ? direction === 'right'
      ? {
          position: 'fixed',
          bottom: Math.max(8, window.innerHeight - anchorRect.bottom),
          left: anchorRect.right + 6,
        }
      : {
          position: 'fixed',
          top: anchorRect.bottom + 8,
          right: window.innerWidth - anchorRect.right,
        }
    : {};

  const dropdown = (
    <div
      ref={dropdownRef}
      className="w-[320px] bg-(--sidebar-bg) rounded-lg shadow-2xl border border-(--divider) z-[9999]"
      style={style}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-(--divider)">
        <h3 className="font-semibold text-(--text-primary) text-sm">{t('notifications.title')}</h3>
        <div className="flex gap-2">
          {notifications.length > 0 && (
            <>
              <button
                onClick={markAllAsRead}
                className="text-xs text-(--accent) hover:text-(--accent-light)"
              >
                {t('notifications.markAllAsRead')}
              </button>
              <span className="text-(--text-muted)">|</span>
              <button
                onClick={dismissAll}
                className="text-xs text-(--error) hover:opacity-80"
              >
                {t('notifications.dismissAll')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Notification List */}
      <div className="max-h-[400px] overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-(--text-muted)">
            <Inbox className="w-12 h-12 mb-2 opacity-40" />
            <p className="text-sm">{t('notifications.noNotifications')}</p>
          </div>
        ) : (
          <div>
            {notifications.map((notification) => {
              const session = getSession(notification.sessionId);
              const isCompleted = notification.type === 'completed';
              const relativeTime = formatRelativeTimeFromNow(notification.timestamp, now, t);

              return (
                <div
                  key={notification.id}
                  onClick={() => handleNotificationClick(notification.id, notification.sessionId)}
                  className={cn(
                    'p-3 hover:bg-(--sidebar-hover) cursor-pointer transition-colors border-b border-(--divider)/50',
                    !notification.read && 'bg-(--accent)/5'
                  )}
                >
                  <div className="flex items-start gap-3">
                    {isCompleted ? (
                      <CheckCircle className="w-4 h-4 text-(--accent) mt-0.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-(--warning) mt-0.5 shrink-0" />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <h4
                          className={cn(
                            'text-sm truncate',
                            !notification.read
                              ? 'font-semibold text-(--text-primary)'
                              : 'font-medium text-(--text-secondary)'
                          )}
                        >
                          {session?.title || `${t('notifications.sessionDefault')} ${notification.sessionId.slice(0, 8)}`}
                        </h4>
                        {!notification.read && (
                          <span className="w-2 h-2 bg-(--accent) rounded-full shrink-0 ml-2" />
                        )}
                      </div>

                      <p className="text-xs text-(--text-muted) line-clamp-2 mb-1">
                        {notification.preview}
                      </p>

                      <div className="flex items-center justify-between text-xs">
                        <span className={isCompleted ? 'text-(--accent)' : 'text-(--warning)'}>
                          {isCompleted ? t('notifications.completed') : t('notifications.inputRequired')}
                        </span>
                        <span className="text-(--text-muted)">{relativeTime}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  // Portal to body to escape sidebar overflow-hidden
  if (anchorRect) {
    return createPortal(dropdown, document.body);
  }

  return dropdown;
}

export function NotificationCenter({ isOpen, ...props }: NotificationCenterProps) {
  if (!isOpen) {
    return null;
  }

  return <NotificationCenterContent {...props} />;
}
