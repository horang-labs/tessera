'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SkillFavoriteButton } from './skill-favorite-button';
import type { SkillInfo } from '@/hooks/use-skill-picker';

interface SkillQuickAccessBarProps {
  sessionId?: string;
  onSelectSkill: (skill: SkillInfo) => void;
  trailingContent?: ReactNode;
}

export function SkillQuickAccessBar({ sessionId, onSelectSkill, trailingContent }: SkillQuickAccessBarProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-[auto_1fr_auto] items-center gap-2 px-3 py-1.5',
        'border-b border-(--divider)',
      )}
    >
      <SkillFavoriteButton sessionId={sessionId} onSelectSkill={onSelectSkill} />
      <div />
      {trailingContent && (
        <div className="flex shrink-0 items-center gap-1.5">
          {trailingContent}
        </div>
      )}
    </div>
  );
}
