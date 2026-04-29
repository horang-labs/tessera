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
import { CollectionGroup } from './collection-group';
import { CollectionQuickCreateSheet } from './collection-quick-create-sheet';
import { getProjectColor } from '@/lib/constants/project-strip';
import { Tooltip } from '@/components/ui/tooltip';
import { buildProjectCollectionGroups } from '@/lib/chat/build-collection-groups';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity, WorkflowStatus } from '@/types/task-entity';
import type { Collection } from '@/types/collection';

const EMPTY_TASKS: TaskEntity[] = [];
const EMPTY_COLLECTIONS: Collection[] = [];

interface AllProjectsListProps {
  activeSessionId: string | null;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick: (session: UnifiedSession) => void;
  onSessionArchive: (sessionId: string) => void;
  onSessionRename: (sessionId: string, newTitle: string) => void;
  onSessionDelete: (sessionId: string) => void;
  onSessionOpenInNewTab: (sessionId: string) => void;
  onSessionGenerateTitle: (sessionId: string) => void;
  onSessionMoveToProject: (sessionId: string) => void;
  onSessionStopProcess: (sessionId: string) => void;
}

export function AllProjectsList({
  activeSessionId,
  onSessionClick,
  onSessionDoubleClick,
  onSessionArchive,
  onSessionRename,
  onSessionDelete,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionMoveToProject,
  onSessionStopProcess,
}: AllProjectsListProps) {
  const projects = useSessionStore((state) => state.projects);

  return (
    <>
      {projects.map((project) => (
        <AllProjectSection
          key={project.encodedDir}
          project={project}
          activeSessionId={activeSessionId}
          onSessionClick={onSessionClick}
          onSessionDoubleClick={onSessionDoubleClick}
          onSessionArchive={onSessionArchive}
          onSessionRename={onSessionRename}
          onSessionDelete={onSessionDelete}
          onSessionOpenInNewTab={onSessionOpenInNewTab}
          onSessionGenerateTitle={onSessionGenerateTitle}
          onSessionMoveToProject={onSessionMoveToProject}
          onSessionStopProcess={onSessionStopProcess}
        />
      ))}
    </>
  );
}

interface AllProjectSectionProps extends AllProjectsListProps {
  project: ProjectGroup;
}

function AllProjectSection({
  project,
  activeSessionId,
  onSessionClick,
  onSessionDoubleClick,
  onSessionArchive,
  onSessionRename,
  onSessionDelete,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionMoveToProject,
  onSessionStopProcess,
}: AllProjectSectionProps) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const [addingCollection, setAddingCollection] = useState(false);
  const [isProjectQuickCreateOpen, setIsProjectQuickCreateOpen] = useState(false);
  const [newCollectionLabel, setNewCollectionLabel] = useState('');
  const newCollectionInputRef = useRef<HTMLInputElement>(null);

  const color = getProjectColor(project.displayName);
  const collections = useCollectionStore((state) => state.collectionsByProject[project.encodedDir] ?? EMPTY_COLLECTIONS);
  const collectionsLoaded = useCollectionStore((state) => state.loadedProjects[project.encodedDir] ?? false);
  const collectionsLoading = useCollectionStore((state) => state.loadingProjectIds[project.encodedDir] ?? false);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const projectTasks = useTaskStore((state) => state.tasksByProject[project.encodedDir] ?? EMPTY_TASKS);
  const tasksLoaded = useTaskStore((state) => state.loadedProjects[project.encodedDir] ?? false);
  const tasksLoading = useTaskStore((state) => state.loadingProjectIds[project.encodedDir] ?? false);
  const collapsedCollections = useBoardStore((state) => state.collapsedCollections);
  const toggleCollectionCollapse = useBoardStore((state) => state.toggleCollectionCollapse);

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

  const hasMissingTaskData = useMemo(() => {
    if (projectTasks.length === 0)
      return project.sessions.some((session) => !session.archived && !!session.taskId);

    const knownTaskIds = new Set(projectTasks.map((task) => task.id));
    return project.sessions.some(
      (session) => !session.archived && !!session.taskId && !knownTaskIds.has(session.taskId)
    );
  }, [project.sessions, projectTasks]);

  useEffect(() => {
    if (!isExpanded) return;
    if (!collectionsLoaded) {
      void useCollectionStore.getState().loadCollections(project.encodedDir, { setCurrent: false });
    }
  }, [collectionsLoaded, isExpanded, project.encodedDir]);

  useEffect(() => {
    if (!isExpanded) return;
    if (tasksLoaded && !hasMissingTaskData) return;
    void loadTasks(project.encodedDir, { setCurrent: false });
  }, [hasMissingTaskData, isExpanded, loadTasks, project.encodedDir, tasksLoaded]);

  useEffect(() => {
    if (!addingCollection || !newCollectionInputRef.current) return;
    newCollectionInputRef.current.focus();
  }, [addingCollection]);

  const collectionGroups = useMemo(
    () => buildProjectCollectionGroups(project, collections, projectTasks),
    [collections, project, projectTasks]
  );

  const visibleSessionCount = useMemo(
    () => project.sessions.filter((session) => !session.archived).length,
    [project.sessions]
  );

  const isProjectDragActive = draggingItem?.projectId === project.encodedDir;
  const isProjectGroupDragActive = draggingGroupId?.startsWith(`${project.encodedDir}::`) ?? false;
  const shouldShowLoading =
    isExpanded && (!collectionsLoaded || !tasksLoaded || collectionsLoading || tasksLoading);

  const handleTaskRename = useCallback((taskId: string, newTitle: string) => {
    void useTaskStore.getState().updateTask(taskId, { title: newTitle });
  }, []);

  const handleTaskDelete = useCallback((taskId: string) => {
    void useTaskStore.getState().deleteTask(taskId);
  }, []);

  const handleTaskStatusChange = useCallback((taskId: string, status: string) => {
    void useTaskStore.getState().updateTask(taskId, { workflowStatus: status as WorkflowStatus });
  }, []);

  const handleAddCollection = useCallback(async () => {
    const label = newCollectionLabel.trim();
    if (!label) {
      setAddingCollection(false);
      setNewCollectionLabel('');
      return;
    }

    await useCollectionStore.getState().addCollection(project.encodedDir, label, '#a78bfa');
    setAddingCollection(false);
    setNewCollectionLabel('');
  }, [newCollectionLabel, project.encodedDir]);

  const handleProjectQuickCreateToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const willOpen = !isProjectQuickCreateOpen;
    setIsProjectQuickCreateOpen(willOpen);
    if (willOpen && !collectionsLoaded) {
      void useCollectionStore.getState().loadCollections(project.encodedDir, { setCurrent: false });
    }
  }, [collectionsLoaded, isProjectQuickCreateOpen, project.encodedDir]);

  return (
    <div className="relative mb-3 mt-3 first:mt-1" data-testid={`all-project-section-${project.encodedDir}`}>
      <div
        className={cn(
          'mx-1 flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors',
          'cursor-pointer hover:bg-(--sidebar-hover)'
        )}
        onClick={() => setIsExpanded((current) => !current)}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-(--text-muted) transition-transform duration-200',
            isExpanded && 'rotate-90'
          )}
        />
        <div
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[0.5rem] font-bold text-white select-none"
          style={{ backgroundColor: color }}
        >
          {project.displayName.charAt(0).toUpperCase()}
        </div>
        <Tooltip content={project.displayName} delay={400} wrapperClassName="flex-1">
          <span className="block truncate text-[0.625rem] font-semibold uppercase tracking-widest text-(--text-muted)">
            {project.displayName}
          </span>
        </Tooltip>
        <span className="shrink-0 tabular-nums text-[0.625rem] text-(--text-muted)">
          {visibleSessionCount}
        </span>
        {project.isCurrent && <Pin className="h-3 w-3 shrink-0 text-(--accent)" />}
        <button
          onClick={handleProjectQuickCreateToggle}
          className="shrink-0 rounded p-0.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-bg) hover:text-(--accent)"
          title={t('sidebar.createNewSession')}
          aria-label={t('sidebar.createNewSession')}
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
          className="left-2 right-2 w-auto"
          scopeId={`project-${project.encodedDir}`}
          onClose={() => setIsProjectQuickCreateOpen(false)}
        />
      )}

      {isExpanded && (
        <div className="ml-2">
          {shouldShowLoading ? (
            <div className="px-4 py-3 text-[0.6875rem] text-(--text-muted)">
              {t('common.loading')}
            </div>
          ) : (
            <>
              {collectionGroups.map((group, groupIdx) => {
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
                    onSessionRename={onSessionRename}
                    onSessionDelete={onSessionDelete}
                    onSessionArchive={onSessionArchive}
                    onSessionOpenInNewTab={onSessionOpenInNewTab}
                    onSessionGenerateTitle={onSessionGenerateTitle}
                    onSessionMoveToProject={onSessionMoveToProject}
                    onSessionStopProcess={onSessionStopProcess}
                  />
                );
              })}

              {addingCollection ? (
                <div className="mx-2 mb-1.5 mt-2">
                  <form
                    className="flex items-center gap-1 rounded-lg border border-(--accent) bg-(--sidebar-bg) px-2 py-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleAddCollection();
                    }}
                  >
                    <input
                      ref={newCollectionInputRef}
                      type="text"
                      value={newCollectionLabel}
                      onChange={(event) => setNewCollectionLabel(event.target.value)}
                      onBlur={() => {
                        void handleAddCollection();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setAddingCollection(false);
                          setNewCollectionLabel('');
                        }
                      }}
                      placeholder="Collection name..."
                      className="flex-1 border-none bg-transparent text-[0.75rem] text-(--sidebar-text-active) outline-none placeholder:text-(--text-muted)"
                    />
                  </form>
                </div>
              ) : (
                <button
                  onClick={() => setAddingCollection(true)}
                  className="mx-2 mb-1 mt-1 flex items-center gap-1.5 rounded px-2 py-1 pl-5 text-[0.6875rem] text-(--text-muted) opacity-55 transition-colors hover:bg-transparent hover:text-(--accent-light) hover:opacity-100"
                >
                  <Plus className="h-2.5 w-2.5" />
                  <span>Add collection</span>
                </button>
              )}

            </>
          )}
        </div>
      )}
    </div>
  );
}
