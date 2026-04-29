'use client';

import type React from 'react';
import { MessageSquare, Plus } from 'lucide-react';

export function SidebarLoadingState({ label }: { label: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-sm text-(--text-muted)">{label}</p>
    </div>
  );
}

export function SidebarEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="px-4 py-8 text-center" data-testid="sidebar-empty-state">
      <MessageSquare className="mx-auto mb-3 h-10 w-10 text-(--text-muted) opacity-40" />
      <p className="text-sm text-(--text-muted)">{title}</p>
      <p className="mt-1 text-xs text-(--text-muted) opacity-60">{description}</p>
    </div>
  );
}

export function SidebarAddCollectionControl({
  isAdding,
  value,
  onStartAdding,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  isAdding: boolean;
  value: string;
  onStartAdding: () => void;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  if (isAdding) {
    return (
      <div className="mx-2 mb-1.5 mt-2">
        <form
          className="flex items-center gap-1 rounded-lg border border-(--accent) bg-(--sidebar-bg) px-2 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <input
            type="text"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onBlur={onSubmit}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onCancel();
              }
            }}
            placeholder="Collection name..."
            className="flex-1 border-none bg-transparent text-[0.75rem] text-(--sidebar-text-active) outline-none placeholder:text-(--text-muted)"
            autoFocus
          />
        </form>
      </div>
    );
  }

  return (
    <div className="mx-2 mb-1.5 mt-2">
      <button
        onClick={onStartAdding}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-(--divider) bg-transparent px-3 py-2 text-[0.6875rem] text-(--text-muted) transition-all hover:border-(--accent) hover:text-(--accent-light)"
      >
        <Plus className="h-3 w-3" />
        Add Collection
      </button>
    </div>
  );
}
