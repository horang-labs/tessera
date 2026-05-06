'use client';

import { useState } from 'react';
import { FolderInput, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { DialogHero } from '@/components/ui/dialog-hero';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import type { UnifiedSession, ProjectGroup } from '@/types/chat';

interface MoveProjectDialogProps {
  session: UnifiedSession | null;
  isOpen: boolean;
  onConfirm: (targetProjectId: string) => void;
  onCancel: () => void;
}

/**
 * MoveProjectDialog — lets the user pick a target project to move a session to.
 * Only shows registered (visible) projects, excluding the session's current project.
 */
export function MoveProjectDialog({
  session,
  isOpen,
  onConfirm,
  onCancel,
}: MoveProjectDialogProps) {
  const { t } = useI18n();
  const projects = useSessionStore((state) => state.projects);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  if (!session) return null;

  // Find current project for display
  const currentProject = projects.find((p) =>
    p.sessions.some((s) => s.id === session.id)
  );

  // Other projects (exclude current)
  const otherProjects = projects.filter(
    (p) => p.encodedDir !== currentProject?.encodedDir
  );

  const handleConfirm = () => {
    if (!selectedProjectId) return;
    onConfirm(selectedProjectId);
    setSelectedProjectId(null);
  };

  const handleCancel = () => {
    setSelectedProjectId(null);
    onCancel();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent data-testid="move-project-dialog">
        <DialogHeader>
          <DialogHero
            title={t('task.moveDialog.title' as Parameters<typeof t>[0])}
            subtitle={t('task.moveDialog.subtitle' as Parameters<typeof t>[0])}
            icon={FolderInput}
            iconContainerClassName="bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
          />
        </DialogHeader>

        <div className="mt-4 mb-4 max-h-[300px] overflow-y-auto">
          {/* Current project (disabled) */}
          {currentProject && (
            <ProjectRow
              project={currentProject}
              isCurrent
              isSelected={false}
              onClick={() => {}}
              t={t}
            />
          )}

          {/* Divider */}
          {currentProject && otherProjects.length > 0 && (
            <div className="my-2 h-px bg-(--divider) opacity-40" />
          )}

          {/* Other projects */}
          {otherProjects.length === 0 ? (
            <p className="text-(--text-muted) text-sm text-center py-6">
              {t('task.moveDialog.noOtherProjects' as Parameters<typeof t>[0])}
            </p>
          ) : (
            otherProjects.map((p) => (
              <ProjectRow
                key={p.encodedDir}
                project={p}
                isCurrent={false}
                isSelected={selectedProjectId === p.decodedPath}
                onClick={() => setSelectedProjectId(p.decodedPath)}
                t={t}
              />
            ))
          )}
        </div>

        <div className="flex gap-3 justify-end">
          <Button
            onClick={handleCancel}
            variant="outline"
            data-testid="move-project-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selectedProjectId}
            data-testid="move-project-confirm"
          >
            {t('task.moveDialog.move' as Parameters<typeof t>[0])}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRow({
  project,
  isCurrent,
  isSelected,
  onClick,
  t,
}: {
  project: ProjectGroup;
  isCurrent: boolean;
  isSelected: boolean;
  onClick: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <button
      type="button"
      onClick={isCurrent ? undefined : onClick}
      disabled={isCurrent}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
        isCurrent && 'opacity-50 cursor-not-allowed',
        !isCurrent && 'hover:bg-(--sidebar-hover) cursor-pointer',
        isSelected && 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] border border-(--accent)',
        !isSelected && !isCurrent && 'border border-transparent',
      )}
      data-testid={`move-project-option-${project.encodedDir}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-(--sidebar-text-active) truncate">
            {project.displayName}
          </span>
          {isCurrent && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-(--sidebar-hover) text-(--text-muted)">
              {t('task.moveDialog.currentProject' as Parameters<typeof t>[0])}
            </span>
          )}
        </div>
        <span className="text-[11px] text-(--text-muted) truncate block">
          {project.displayPath ?? project.decodedPath}
        </span>
      </div>
      {isSelected && (
        <Check className="w-4 h-4 shrink-0 text-(--accent)" />
      )}
    </button>
  );
}
