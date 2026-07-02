'use client';

import { memo, useCallback, useMemo } from 'react';
import type { RecentWorkItem } from '@/lib/chat/recent-work';
import { useI18n } from '@/lib/i18n';
import { useBoardStore } from '@/stores/board-store';
import { CollectionGroup, type CollectionGroupProps } from './collection-group';

const RECENT_WORK_GROUP_ID = '__recent_work';

type RecentWorkSectionProps = Pick<
  CollectionGroupProps,
  | 'contextMenuCollections'
  | 'projectId'
  | 'projectDir'
  | 'onSessionClick'
  | 'onSessionDoubleClick'
  | 'activeSessionId'
  | 'onTaskRename'
  | 'onTaskDelete'
  | 'onTaskStatusChange'
  | 'onChatStatusChange'
  | 'onSessionRename'
  | 'onSessionDelete'
  | 'onSessionArchive'
  | 'onSessionOpenInNewTab'
  | 'onSessionGenerateTitle'
  | 'onSessionMoveToProject'
  | 'onSessionStopProcess'
> & {
  items: RecentWorkItem[];
};

const noopItemDragStart: CollectionGroupProps['onItemDragStart'] = () => {};
const noopDragEnd: CollectionGroupProps['onItemDragEnd'] = () => {};
const noopCollectionDragOver: CollectionGroupProps['onCollectionDragOver'] = () => {};
const noopCollectionDragLeave: CollectionGroupProps['onCollectionDragLeave'] = () => {};
const noopCollectionDrop: CollectionGroupProps['onCollectionDrop'] = () => {};
const noopItemDragOverItem: CollectionGroupProps['onItemDragOverItem'] = () => {};
const noopGroupDragStart: CollectionGroupProps['onGroupDragStart'] = () => {};
const noopGroupDragEnd: CollectionGroupProps['onGroupDragEnd'] = () => {};
const noopGroupDragOver: CollectionGroupProps['onGroupDragOver'] = () => {};
const noopGroupDragLeave: CollectionGroupProps['onGroupDragLeave'] = () => {};
const noopGroupDrop: CollectionGroupProps['onGroupDrop'] = () => {};

export const RecentWorkSection = memo(function RecentWorkSection({
  items,
  ...groupProps
}: RecentWorkSectionProps) {
  const { t } = useI18n();
  const collapseScopeKey = `${groupProps.projectId}::${RECENT_WORK_GROUP_ID}`;
  const isCollapsed = useBoardStore((state) => state.collapsedCollections[collapseScopeKey] ?? false);
  const setCollectionCollapsed = useBoardStore((state) => state.setCollectionCollapsed);
  const toggleCollapsed = useCallback(() => {
    setCollectionCollapsed(collapseScopeKey, !isCollapsed);
  }, [collapseScopeKey, isCollapsed, setCollectionCollapsed]);

  const tasks = useMemo(
    () => items.flatMap((item) => (item.type === 'task' ? [item.task] : [])),
    [items],
  );
  const chats = useMemo(
    () => items.flatMap((item) => (item.type === 'chat' ? [item.session] : [])),
    [items],
  );
  const orderedItems = useMemo(
    () => items.map((item) => ({ type: item.type, id: item.id })),
    [items],
  );

  if (items.length === 0) return null;

  return (
    <div className="mb-2" data-testid="recent-work-section">
      <CollectionGroup
        {...groupProps}
        collection={null}
        tasks={tasks}
        chats={chats}
        orderedItems={orderedItems}
        collapsed={isCollapsed}
        onToggleCollapse={toggleCollapsed}
        isDragActive={false}
        isDragOver={false}
        onItemDragStart={noopItemDragStart}
        onItemDragEnd={noopDragEnd}
        onCollectionDragOver={noopCollectionDragOver}
        onCollectionDragLeave={noopCollectionDragLeave}
        onCollectionDrop={noopCollectionDrop}
        onItemDragOverItem={noopItemDragOverItem}
        dropIndicator={null}
        isGroupDragging={false}
        isGroupDragOver={false}
        onGroupDragStart={noopGroupDragStart}
        onGroupDragEnd={noopGroupDragEnd}
        onGroupDragOver={noopGroupDragOver}
        onGroupDragLeave={noopGroupDragLeave}
        onGroupDrop={noopGroupDrop}
        disableDnd
        allowPanelSessionDnd
        groupIdOverride={RECENT_WORK_GROUP_ID}
        headerLabel={t('sidebar.recentWork')}
        hideHeaderActions
        disableAutoExpand
      />
    </div>
  );
});
