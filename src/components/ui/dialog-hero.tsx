'use client';

import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DialogTitle } from '@/components/ui/dialog';

interface DialogHeroProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon: ComponentType<{ className?: string }>;
  iconContainerClassName?: string;
  iconClassName?: string;
}

export function DialogHero({
  title,
  subtitle,
  icon: Icon,
  iconContainerClassName,
  iconClassName,
}: DialogHeroProps) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-full bg-(--accent)/10',
          iconContainerClassName,
        )}
      >
        <Icon className={cn('h-5 w-5 text-(--accent)', iconClassName)} />
      </div>
      <div>
        <DialogTitle>{title}</DialogTitle>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-(--text-muted)">
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}
