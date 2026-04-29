'use client';

import { useState } from 'react';
import { Star, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SkillInfo } from '@/hooks/use-skill-picker';
import type { SkillDetail } from '@/lib/skill/skill-analysis-types';
import { useI18n } from '@/lib/i18n';

interface SkillCardProps {
  skill: SkillInfo;
  shortName: string;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  /** LLM-generated analysis for this skill */
  analysis?: SkillDetail;
}

export function SkillCard({
  skill,
  shortName,
  isFavorite,
  onToggleFavorite,
  analysis,
}: SkillCardProps) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);

  const displayName = analysis?.displayName;
  const summary = analysis?.summary || skill.description || t('skill.noDescription');
  const whenToUse = analysis?.whenToUse;
  const role = analysis?.role;
  const order = analysis?.order;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        'bg-(--bg-secondary)',
        isFavorite
          ? 'border-(--accent)/40'
          : 'border-(--divider)',
        'hover:border-(--accent)/30',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 text-left min-w-0"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-(--accent-light) truncate">
              /{shortName}
            </span>
            {role && (
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
                  role === 'entry' && 'bg-(--accent)/15 text-(--accent-light)',
                  role === 'core' && 'bg-blue-500/15 text-blue-400',
                  role === 'support' && 'bg-(--divider) text-(--text-muted)',
                )}
              >
                {role === 'entry' ? t('skill.roleEntry') : role === 'core' ? t('skill.roleCore') : t('skill.roleSupport')}
              </span>
            )}
            {order != null && (
              <span className="text-[10px] text-(--text-muted) shrink-0">
                #{order}
              </span>
            )}
          </div>
          {displayName && (
            <div className="text-xs text-(--text-secondary) mt-0.5 truncate">
              {displayName}
            </div>
          )}
          <div
            className={cn(
              'mt-1 text-xs text-(--text-muted)',
              isExpanded ? '' : 'line-clamp-2',
            )}
          >
            {summary}
          </div>
        </button>

        <div className="flex items-center gap-1 shrink-0">
          {/* Favorite toggle */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              isFavorite
                ? 'text-(--accent) hover:text-(--accent-light)'
                : 'text-(--text-muted) hover:text-(--accent)',
            )}
            title={isFavorite ? t('skill.removeFavorite') : t('skill.addFavorite')}
            aria-label={isFavorite ? t('skill.removeFavorite') : t('skill.addFavorite')}
          >
            <Star
              className={cn('w-4 h-4', isFavorite && 'fill-current')}
            />
          </button>

          {/* Expand toggle */}
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded-md text-(--text-muted) hover:text-(--text-secondary) transition-colors"
            aria-label={isExpanded ? t('skill.collapse') : t('skill.expand')}
          >
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="mt-2 pt-2 border-t border-(--divider) space-y-2">
          {whenToUse && (
            <div>
              <span className="text-[10px] font-semibold text-(--text-secondary) uppercase tracking-wider">
                {t('skill.whenToUse')}
              </span>
              <p className="text-xs text-(--text-muted) mt-0.5">
                {whenToUse}
              </p>
            </div>
          )}
          {skill.name !== shortName && (
            <div>
              <span className="text-[10px] text-(--text-muted) font-mono">
                {skill.name}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
