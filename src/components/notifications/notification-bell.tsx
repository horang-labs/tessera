'use client';

import { useState, useRef, useCallback } from 'react';
import { Bell } from 'lucide-react';
import { useNotificationStore } from '@/stores/notification-store';
import { NotificationCenter } from './notification-center';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

interface NotificationBellProps {
  /** Dropdown open direction: 'down' (header) or 'right' (vertical strip) */
  direction?: 'down' | 'right';
}

export function NotificationBell({ direction = 'down' }: NotificationBellProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const unreadCount = useNotificationStore((state) => state.getUnreadCount());
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleToggle = useCallback(() => {
    if (!isOpen && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setIsOpen((v) => !v);
  }, [isOpen]);

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size={direction === 'right' ? 'icon-lg' : 'icon'}
        onClick={handleToggle}
        aria-label={t('notifications.title')}
        title={t('notifications.title')}
        className={direction === 'right' ? 'relative rounded-none h-11 w-9 mx-auto' : 'relative'}
      >
        <Bell className={direction === 'right' ? 'w-5 h-5' : 'w-4 h-4'} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-(--error) text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>

      {isOpen && (
        <NotificationCenter
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          anchorRect={anchorRect}
          triggerRef={buttonRef}
          direction={direction}
        />
      )}
    </div>
  );
}
