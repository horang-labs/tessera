'use client';

import type { ReactNode } from 'react';
import { useLoadedProjectViews } from '@/hooks/use-project-view-workspace-state';
import { getProjectColor } from '@/lib/constants/project-strip';
import { cn } from '@/lib/utils';
import type { UnifiedSession } from '@/types/chat';

/** Match the project rail using the Session's stable origin, even across views. */
export function SessionProjectBadge({ session, className, children }: { session?: UnifiedSession; className?: string; children?: ReactNode }) {
  const projects = useLoadedProjectViews();
  const project = projects.find((candidate) => candidate.encodedDir === session?.originProjectId);
  if (!project) return <>{children}</>;

  return (
    <span
      className={cn("relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold leading-none text-white", className)}
      style={{ backgroundColor: getProjectColor(project.displayName) }}
      title={project.displayName}
      aria-label={project.displayName}
      data-testid="session-project-badge"
    >
      {project.displayName.charAt(0).toUpperCase()}
      {children && <span className="absolute -right-0.5 -top-0.5 flex origin-top-right scale-50 items-center justify-center rounded-full bg-(--chat-header-bg) ring-2 ring-(--chat-header-bg)">{children}</span>}
    </span>
  );
}
