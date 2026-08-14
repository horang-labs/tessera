'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Pin, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { useBoardStore } from '@/stores/board-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useTaskStore } from '@/stores/task-store';
import { useCollectionDnd } from '@/hooks/use-collection-dnd';
import { useOriginProjectRepresentation } from '@/hooks/use-project-view-workspace-state';
import { CollectionGroup } from './collection-group';
import { CollectionQuickCreateSheet } from './collection-quick-create-sheet';
import { getProjectColor } from '@/lib/constants/project-strip';
import { Tooltip } from '@/components/ui/tooltip';
import {
  buildProjectCollectionGroups,
  countRunningCollectionGroupItems,
  filterCollectionGroupsByRunning,
} from '@/lib/chat/build-collection-groups';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity, WorkflowStatus } from '@/types/task-entity';
import type { Collection } from '@/types/collection';
import {
  originProjectContainsRunningSession,
} from '@/lib/projects/origin-project-representation';
import { CompactProjectWorktreeRow } from '@/components/worktree/project-worktree-row';
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';
import { selectActiveTab, usePanelStore } from '@/stores/panel-store';
import { shouldShowAllProjectLoading } from './sidebar-utils';
import { PHONE_TOUCH_TARGET } from '@/lib/ui/touch-target';

const EMPTY_TASKS: TaskEntity[] = [];
const EMPTY_COLLECTIONS: Collection[] = [];

interface AllProjectsListProps {
  activeSessionId: string | null;
  isRunningFilterActive: boolean;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick: (session: UnifiedSession) => void;
  onSessionArchive: (sessionId: string, task?: TaskEntity) => void;
  onSessionRename: (sessionId: string, newTitle: string) => void;
  onSessionDelete: (sessionId: string) => void;
  onSessionOpenInNewTab: (sessionId: string) => void;
  onSessionGenerateTitle: (sessionId: string) => void;
  onSessionStopProcess: (sessionId: string) => void;
  onChatStatusChange: (sessionId: string, status: string) => void;
}

export function AllProjectsList({
  activeSessionId,
  isRunningFilterActive,
  onSessionClick,
  onSessionDoubleClick,
  onSessionArchive,
  onSessionRename,
  onSessionDelete,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionStopProcess,
  onChatStatusChange,
}: AllProjectsListProps) {
  const representation = useOriginProjectRepresentation();
  const activePanelWorktreeId = usePanelStore((state) => {
    const tab = selectActiveTab(state);
    return tab?.panels[tab.activePanelId]?.worktreeId ?? null;
  });
  const peekWorktreeId = useWorkspacePeekStore((state) => state.target?.worktreeId ?? null);
  const activeWorktreeId = peekWorktreeId ?? activePanelWorktreeId;
  const visibleProjects = useMemo(() => {
    if (!isRunningFilterActive) return representation.projects;
    return representation.projects.filter((project) => originProjectContainsRunningSession(
      project,
      representation.tasksByProject[project.encodedDir] ?? EMPTY_TASKS,
    ));
  }, [isRunningFilterActive, representation]);

  return (
    <>
      {visibleProjects.map((project) => (
        <AllProjectSection
          key={project.encodedDir}
          project={project}
          projectTasks={representation.tasksByProject[project.encodedDir] ?? EMPTY_TASKS}
          activeWorktreeId={activeWorktreeId}
          activeSessionId={activeSessionId}
          isRunningFilterActive={isRunningFilterActive}
          onSessionClick={onSessionClick}
          onSessionDoubleClick={onSessionDoubleClick}
          onSessionArchive={onSessionArchive}
          onSessionRename={onSessionRename}
          onSessionDelete={onSessionDelete}
          onSessionOpenInNewTab={onSessionOpenInNewTab}
          onSessionGenerateTitle={onSessionGenerateTitle}
          onSessionStopProcess={onSessionStopProcess}
          onChatStatusChange={onChatStatusChange}
        />
      ))}
    </>
  );
}

interface AllProjectSectionProps extends AllProjectsListProps {
  activeWorktreeId: string | null;
  project: ProjectGroup;
  projectTasks: TaskEntity[];
}

function AllProjectSection({
  activeWorktreeId,
  project,
  projectTasks,
  activeSessionId,
  isRunningFilterActive,
  onSessionClick,
  onSessionDoubleClick,
  onSessionArchive,
  onSessionRename,
  onSessionDelete,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionStopProcess,
  onChatStatusChange,
}: AllProjectSectionProps) {
  const { t } = useI18n();
  const [isProjectQuickCreateOpen, setIsProjectQuickCreateOpen] = useState(false);
  const projectQuickCreateTriggerRef = useRef<HTMLButtonElement>(null);

  const color = getProjectColor(project.displayName);
  const collections = useCollectionStore((state) => state.collectionsByProject[project.encodedDir] ?? EMPTY_COLLECTIONS);
  const collectionsLoaded = useCollectionStore((state) => state.loadedProjects[project.encodedDir] ?? false);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const tasksLoaded = useTaskStore((state) => state.loadedProjects[project.encodedDir] ?? false);
  const collapsedCollections = useBoardStore((state) => state.collapsedCollections);
  const toggleCollectionCollapse = useBoardStore((state) => state.toggleCollectionCollapse);
  const isExpanded = useBoardStore((state) => state.allProjectsExpandedSections?.[project.encodedDir] ?? false);
  const toggleAllProjectsSection = useBoardStore((state) => state.toggleAllProjectsSection ?? (() => {}));

  const {
    draggingItem,
    dragOverCollectionId,
    collectionDropIndicator,
    handleItemDragStart,
    handleItemDragEnd,
    handleCollectionDragOver,
    handleCollectionDragLeave,
    handleCollectionDrop,
    handleItemDragOverItem,
    draggingGroupId,
    groupDragOverIndex,
    handleGroupDragStart,
    handleGroupDragEnd,
    handleGroupDragOver,
    handleGroupDragLeave,
    handleGroupDrop,
  } = useCollectionDnd();

  useEffect(() => {
    if (!isExpanded) return;
    if (isRunningFilterActive) return;
    if (!collectionsLoaded) {
      void useCollectionStore.getState().loadCollections(project.encodedDir, { setCurrent: false });
    }
  }, [collectionsLoaded, isExpanded, isRunningFilterActive, project.encodedDir]);

  useEffect(() => {
    if (!isExpanded) return;
    if (tasksLoaded) return;
    void loadTasks(project.encodedDir, { setCurrent: false });
  }, [isExpanded, loadTasks, project.encodedDir, tasksLoaded]);

  const collectionGroups = useMemo(
    () => buildProjectCollectionGroups(project, collections, projectTasks),
    [collections, project, projectTasks]
  );
  const visibleCollectionGroups = useMemo(
    () => isRunningFilterActive ? filterCollectionGroupsByRunning(collectionGroups) : collectionGroups,
    [collectionGroups, isRunningFilterActive],
  );
  const runningFlatItems = useMemo(() => {
    const flatTasks: TaskEntity[] = [];
    const flatChats: UnifiedSession[] = [];
    if (!isRunningFilterActive) {
      return { tasks: flatTasks, chats: flatChats };
    }

    for (const group of visibleCollectionGroups) {
      flatTasks.push(...group.tasks);
      flatChats.push(...group.chats);
    }

    return { tasks: flatTasks, chats: flatChats };
  }, [isRunningFilterActive, visibleCollectionGroups]);

  const visibleSessionCount = useMemo(
    () => new Set(collectionGroups.flatMap((group) => [
      ...group.chats.map((session) => session.id),
      ...group.tasks.flatMap((task) => task.sessions.map((session) => session.id)),
    ])).size,
    [collectionGroups],
  );
  const runningSessionCount = useMemo(
    () => countRunningCollectionGroupItems(collectionGroups),
    [collectionGroups],
  );
  const sectionSessionCount = isRunningFilterActive ? runningSessionCount : visibleSessionCount;

  const isProjectDragActive = draggingItem?.projectId === project.encodedDir;
  const isProjectGroupDragActive = draggingGroupId?.startsWith(`${project.encodedDir}::`) ?? false;
  const shouldShowLoading = shouldShowAllProjectLoading({
    isExpanded,
    isRunningFilterActive,
    collectionsLoaded,
    tasksLoaded,
  });

  const handleTaskRename = useCallback((taskId: string, newTitle: string) => {
    void useTaskStore.getState().updateTask(taskId, { title: newTitle });
  }, []);

  const handleTaskDelete = useCallback((taskId: string) => {
    void useTaskStore.getState().deleteWorktree(taskId);
  }, []);

  const handleTaskStatusChange = useCallback((taskId: string, status: string) => {
    void useTaskStore.getState().updateTask(taskId, { workflowStatus: status as WorkflowStatus });
  }, []);

  const handleProjectQuickCreateToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const willOpen = !isProjectQuickCreateOpen;
    setIsProjectQuickCreateOpen(willOpen);
    if (willOpen && !collectionsLoaded) {
      void useCollectionStore.getState().loadCollections(project.encodedDir, { setCurrent: false });
    }
  }, [collectionsLoaded, isProjectQuickCreateOpen, project.encodedDir]);

  const handleProjectWorktreeSelect = useCallback(() => {
    const projectWorktree = project.projectWorktree;
    if (!projectWorktree) return;
    useWorkspacePeekStore.getState().openWorktree(
      projectWorktree.id,
      project.encodedDir,
    );
  }, [project.encodedDir, project.projectWorktree]);

  return (
    <div className="relative mb-3 mt-3 first:mt-1" data-testid={`all-project-section-${project.encodedDir}`}>
      <div
        className={cn(
          'flex items-center gap-1 rounded-md py-1.5 pl-0 pr-2 transition-colors',
          'cursor-pointer hover:bg-(--sidebar-hover)',
        )}
        onClick={() => toggleAllProjectsSection(project.encodedDir)}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-(--text-muted) transition-transform duration-200',
            isExpanded && 'rotate-90',
          )}
        />
        <div
          className="flex h-4 w-4 mr-0.5 shrink-0 items-center justify-center rounded text-[0.5rem] font-bold text-white select-none"
          style={{ backgroundColor: color }}
        >
          {project.displayName.charAt(0).toUpperCase()}
        </div>
        <Tooltip content={project.displayName} delay={400} wrapperClassName="min-w-0 flex-1">
          <span className="block truncate text-[0.625rem] font-semibold uppercase tracking-widest text-(--text-muted)">
            {project.displayName}
          </span>
        </Tooltip>
        <span className="shrink-0 tabular-nums text-[0.625rem] text-(--text-muted)">
          {sectionSessionCount}
        </span>
        {project.isCurrent ? <Pin className="h-3 w-3 shrink-0 text-(--accent)" /> : null}
        <button
          ref={projectQuickCreateTriggerRef}
          type="button"
          onClick={handleProjectQuickCreateToggle}
          className={cn(
            'shrink-0 rounded p-0.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-bg) hover:text-(--accent)',
            PHONE_TOUCH_TARGET,
          )}
          title={t('sidebar.createNewSession')}
          aria-label={t('sidebar.createNewSession')}
          data-testid={`all-project-quick-create-toggle-${project.encodedDir}`}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {isProjectQuickCreateOpen && (
        <CollectionQuickCreateSheet
          collection={null}
          collections={collections}
          projectDir={project.decodedPath}
          projectId={project.encodedDir}
          allowCollectionSelection
          anchorRef={projectQuickCreateTriggerRef}
          scopeId={`project-${project.encodedDir}`}
          onClose={() => setIsProjectQuickCreateOpen(false)}
        />
      )}

      {isExpanded && (
        <div className="ml-2">
          {project.projectWorktree ? (
            <CompactProjectWorktreeRow
              active={activeWorktreeId === project.projectWorktree.id}
              branch={project.projectWorktree.currentBranch}
              diffStats={project.projectWorktree.diffStats}
              displayPath={project.projectWorktree.displayPath}
              onSelect={handleProjectWorktreeSelect}
            />
          ) : null}
          {shouldShowLoading ? (
            <div className="px-4 py-3 text-[0.6875rem] text-(--text-muted)">
              {t('common.loading')}
            </div>
          ) : isRunningFilterActive ? (
            <CollectionGroup
              key={`running-flat-${project.encodedDir}`}
              collection={null}
              contextMenuCollections={collections}
              projectId={project.encodedDir}
              projectDir={project.decodedPath}
              tasks={runningFlatItems.tasks}
              chats={runningFlatItems.chats}
              collapsed={false}
              onToggleCollapse={() => {}}
              onSessionClick={onSessionClick}
              onSessionDoubleClick={onSessionDoubleClick}
              activeSessionId={activeSessionId}
              isDragActive={false}
              isDragOver={false}
              onItemDragStart={handleItemDragStart}
              onItemDragEnd={handleItemDragEnd}
              onCollectionDragOver={handleCollectionDragOver}
              onCollectionDragLeave={handleCollectionDragLeave}
              onCollectionDrop={handleCollectionDrop}
              onItemDragOverItem={handleItemDragOverItem}
              dropIndicator={null}
              isGroupDragging={false}
              isGroupDragOver={false}
              onGroupDragStart={handleGroupDragStart}
              onGroupDragEnd={handleGroupDragEnd}
              onGroupDragOver={(event) => handleGroupDragOver(0, event)}
              onGroupDragLeave={(event) => handleGroupDragLeave(0, event)}
              onGroupDrop={(event) => handleGroupDrop(project.encodedDir, 0, event)}
              onTaskRename={handleTaskRename}
              onTaskDelete={handleTaskDelete}
              onTaskStatusChange={handleTaskStatusChange}
              onChatStatusChange={onChatStatusChange}
              onSessionRename={onSessionRename}
              onSessionDelete={onSessionDelete}
              onSessionArchive={onSessionArchive}
              onSessionOpenInNewTab={onSessionOpenInNewTab}
              onSessionGenerateTitle={onSessionGenerateTitle}
              onSessionStopProcess={onSessionStopProcess}
              disableDnd
              allowPanelSessionDnd
              hideHeader
            />
          ) : (
            visibleCollectionGroups.map((group, groupIdx) => {
              const collection = group.collectionId
                ? collections.find((item) => item.id === group.collectionId) ?? null
                : null;
              const collectionId = group.collectionId ?? '__uncategorized';
              const collectionScopeId = `${project.encodedDir}::${collectionId}`;

              return (
                <CollectionGroup
                  key={collectionScopeId}
                  collection={collection}
                  contextMenuCollections={collections}
                  projectId={project.encodedDir}
                  projectDir={project.decodedPath}
                  tasks={group.tasks}
                  chats={group.chats}
                  collapsed={collapsedCollections[collectionScopeId] ?? false}
                  onToggleCollapse={() => toggleCollectionCollapse(collectionScopeId)}
                  onSessionClick={onSessionClick}
                  onSessionDoubleClick={onSessionDoubleClick}
                  activeSessionId={activeSessionId}
                  isDragActive={isProjectDragActive}
                  isDragOver={dragOverCollectionId === collectionScopeId}
                  onItemDragStart={handleItemDragStart}
                  onItemDragEnd={handleItemDragEnd}
                  onCollectionDragOver={handleCollectionDragOver}
                  onCollectionDragLeave={handleCollectionDragLeave}
                  onCollectionDrop={handleCollectionDrop}
                  onItemDragOverItem={handleItemDragOverItem}
                  dropIndicator={isProjectDragActive ? collectionDropIndicator : null}
                  isGroupDragging={draggingGroupId === collectionScopeId}
                  isGroupDragOver={isProjectGroupDragActive && groupDragOverIndex === groupIdx}
                  onGroupDragStart={handleGroupDragStart}
                  onGroupDragEnd={handleGroupDragEnd}
                  onGroupDragOver={(event) => handleGroupDragOver(groupIdx, event)}
                  onGroupDragLeave={(event) => handleGroupDragLeave(groupIdx, event)}
                  onGroupDrop={(event) => handleGroupDrop(project.encodedDir, groupIdx, event)}
                  onTaskRename={handleTaskRename}
                  onTaskDelete={handleTaskDelete}
                  onTaskStatusChange={handleTaskStatusChange}
                  onChatStatusChange={onChatStatusChange}
                  onSessionRename={onSessionRename}
                  onSessionDelete={onSessionDelete}
                  onSessionArchive={onSessionArchive}
                  onSessionOpenInNewTab={onSessionOpenInNewTab}
                  onSessionGenerateTitle={onSessionGenerateTitle}
                  onSessionStopProcess={onSessionStopProcess}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
