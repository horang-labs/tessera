import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Notification } from '@/types/notification';

const MAX_NOTIFICATIONS = 50;
type ActionToastType = 'success' | 'error' | 'warning' | 'info';

// Simple action toast (e.g. "Session created", "Failed to delete")
export interface ActionToast {
  id: string;
  message: string;
  type: ActionToastType;
  timestamp: number;
  action?: { label: string; onClick: () => void };
}

interface NotificationState {
  // Session-level notifications (WebSocket: completed, input_required)
  notifications: Notification[];
  soundTrigger: number;

  // Simple action toasts
  toasts: ActionToast[];

  // Notification actions
  /** Returns false when a notification with the same dedupKey already exists (nothing added). */
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read' | 'dismissed'>) => boolean;
  dismissNotification: (id: string) => void;
  dismissToast: (id: string) => void;
  dismissAll: () => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  markSessionAsRead: (sessionId: string) => void;
  playSound: () => void;

  // Action toast actions
  showToast: (message: string, type?: ActionToastType) => void;
  showToastWithAction: (message: string, type: ActionToastType, action: { label: string; onClick: () => void }) => void;
  dismissActionToast: (id: string) => void;

  // Computed
  getUnreadCount: () => number;
  getUnreadSessionIds: () => Set<string>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  soundTrigger: 0,
  toasts: [],

  addNotification: (notification) => {
    // Orca식 dedup: 같은 dedupKey가 이미 있으면(dismissed 무관) 재발화를 무시한다.
    // 재연결/리로드 replay와 근접 이중(Stop+result)이 unread/sound를 부풀리는 걸 막는다.
    if (notification.dedupKey) {
      const seen = get().notifications.some((n) => n.dedupKey === notification.dedupKey);
      if (seen) return false;
    }

    set((state) => {
      const updatedExisting = state.notifications.map((n) =>
        n.sessionId === notification.sessionId && !n.dismissed
          ? { ...n, dismissed: true }
          : n
      );

      const newNotification: Notification = {
        ...notification,
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        read: false,
        dismissed: false,
      };

      let updated = [newNotification, ...updatedExisting];
      if (updated.length > MAX_NOTIFICATIONS) {
        updated = updated.slice(0, MAX_NOTIFICATIONS);
      }

      return { notifications: updated };
    });
    return true;
  },

  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  dismissToast: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, dismissed: true } : n
      ),
    })),

  dismissAll: () => set({ notifications: [] }),

  markAsRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      ),
    })),

  markAllAsRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
    })),

  markSessionAsRead: (sessionId) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.sessionId === sessionId ? { ...n, read: true } : n
      ),
    })),

  playSound: () => set((state) => ({ soundTrigger: state.soundTrigger + 1 })),

  showToast: (message, type = 'success') =>
    set((state) => ({
      toasts: [...state.toasts, { id: uuidv4(), message, type, timestamp: Date.now() }],
    })),

  showToastWithAction: (message, type, action) =>
    set((state) => ({
      toasts: [...state.toasts, { id: uuidv4(), message, type, timestamp: Date.now(), action }],
    })),

  dismissActionToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  getUnreadCount: () => {
    return get().notifications.filter((n) => !n.read).length;
  },

  getUnreadSessionIds: () => {
    const unread = get().notifications.filter((n) => !n.read);
    return new Set(unread.map((n) => n.sessionId));
  },
}));

// Shorthand for non-React contexts (hooks, event handlers)
export const toast = {
  success: (message: string) => useNotificationStore.getState().showToast(message, 'success'),
  error: (message: string) => useNotificationStore.getState().showToast(message, 'error'),
  warning: (message: string) => useNotificationStore.getState().showToast(message, 'warning'),
  info: (message: string) => useNotificationStore.getState().showToast(message, 'info'),
};
