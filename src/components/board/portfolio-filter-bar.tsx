'use client';

import { memo } from 'react';
import { Layers3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getProjectColor } from '@/lib/constants/project-strip';
import type { ProjectGroup } from '@/types/chat';

interface PortfolioFilterBarProps {
  projects: ProjectGroup[];
  activeProjectId: string | null;
  onProjectFilter: (projectId: string | null) => void;
}

export const PortfolioFilterBar = memo(function PortfolioFilterBar({
  projects,
  activeProjectId,
  onProjectFilter,
}: PortfolioFilterBarProps) {
  const { t } = useI18n();

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-(--divider) bg-(--board-bg) px-3 py-2"
      data-testid="portfolio-filter-bar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none">
        <button
          type="button"
          onClick={() => onProjectFilter(null)}
          aria-pressed={activeProjectId === null}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-2xl border px-3 py-1',
            'text-[0.75rem] font-medium whitespace-nowrap transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/35',
            activeProjectId === null
              ? 'border-(--accent) bg-(--accent) text-white'
              : 'border-transparent bg-(--sidebar-hover) text-(--text-muted) hover:bg-(--sidebar-active) hover:text-(--text-primary)',
          )}
          data-testid="portfolio-filter-all"
        >
          <Layers3 className="h-3 w-3" />
          <span>{t('projectStrip.allProjects')}</span>
        </button>

        {projects.map((project) => {
          const isActive = activeProjectId === project.encodedDir;
          return (
            <button
              key={project.encodedDir}
              type="button"
              onClick={() => onProjectFilter(isActive ? null : project.encodedDir)}
              aria-pressed={isActive}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-2xl border px-2.5 py-1',
                'text-[0.75rem] font-medium whitespace-nowrap transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/35',
                isActive
                  ? 'border-[color-mix(in_srgb,var(--accent)_45%,var(--divider))] bg-(--sidebar-active) text-(--text-primary)'
                  : 'border-transparent bg-(--sidebar-hover) text-(--text-muted) hover:bg-(--sidebar-active) hover:text-(--text-primary)',
              )}
              data-testid={`portfolio-filter-${project.encodedDir}`}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: getProjectColor(project.displayName) }}
                aria-hidden="true"
              />
              <span>{project.displayName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

