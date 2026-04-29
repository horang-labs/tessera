import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Notification } from '@/types/notification';

const MAX_NOTIFICATIONS = 50;

// Simple action toast (e.g. "Session created", "Failed to delete")
export interface ActionToast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning';
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
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read' | 'dismissed'>) => void;
  dismissNotification: (id: string) => void;
  dismissToast: (id: string) => void;
  dismissAll: () => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  markSessionAsRead: (sessionId: string) => void;
  playSound: () => void;

  // Action toast actions
  showToast: (message: string, type?: 'success' | 'error' | 'warning') => void;
  showToastWithAction: (message: string, type: 'success' | 'error' | 'warning', action: { label: string; onClick: () => void }) => void;
  dismissActionToast: (id: string) => void;

  // Computed
  getUnreadCount: () => number;
  getUnreadSessionIds: () => Set<string>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  soundTrigger: 0,
  toasts: [],

  addNotification: (notification) =>
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
    }),

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
};
