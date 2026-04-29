'use client';

import { useEffect, useRef } from 'react';
import { useNotificationStore } from '@/stores/notification-store';
import { useSettingsStore } from '@/stores/settings-store';

export function NotificationSound() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevNotificationCount = useRef(0);
  const prevSoundTrigger = useRef(0);
  const notifications = useNotificationStore((state) => state.notifications);
  const soundTrigger = useNotificationStore((state) => state.soundTrigger);
  const soundEnabled = useSettingsStore(
    (state) => state.settings.notifications?.soundEnabled ?? true
  );

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio('/sounds/notification.wav');
      audioRef.current.volume = 0.6;
    }
  }, []);

  useEffect(() => {
    const hasNewNotification = notifications.length > prevNotificationCount.current;
    const hasSoundTrigger = soundTrigger > prevSoundTrigger.current;

    if ((hasNewNotification || hasSoundTrigger) && soundEnabled && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((error) => {
        console.warn('Failed to play notification sound:', error);
      });
    }

    prevNotificationCount.current = notifications.length;
    prevSoundTrigger.current = soundTrigger;
  }, [notifications.length, soundTrigger, soundEnabled]);

  return null;
}
