"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ChevronsDownUp, ChevronsUpDown, ClipboardPaste, Copy, CopyPlus, ExternalLink, FilePlus2,
  FolderOpen, FolderPlus, Link2, SquareTerminal, PenLine, Scissors, Trash2,
} from "lucide-react";
import { useCloseOnEscape } from "@/hooks/use-close-on-escape";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import {
  canUseElectronFileActions,
  copyText,
  getElectronPlatform,
  getRevealFileLabel,
  openFilePathOnHost,
  revealFilePathOnHost,
} from "@/lib/workspace-tabs/file-path-actions";
import { cn } from "@/lib/utils";
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

/**
 * The tree operations, when the surface that opened this menu has them. A file
 * explorer keeps these on the right-click menu rather than on a strip of icons
 * that appears on every row the pointer crosses.
 */
export interface WorkspaceEntryMenuActions {
  /** Absent on the empty-background menu: there is no row to act on. */
  onDelete?: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onDuplicate?: () => void;
  /** Absent when there is nothing on the clipboard to paste. */
  onPaste?: () => void;
  onCopyRelativePath?: () => void;
  /** Starts a shell in the folder the menu was opened on. */
  onOpenTerminal?: () => void;
  /** Folder rows only. */
  onExpandChildren?: () => void;
  onCollapseChildren?: () => void;
}

interface WorkspaceFileContextMenuProps {
  absolutePath: string;
  canOpenFile?: boolean;
  entryActions?: WorkspaceEntryMenuActions;
  selectionActions?: {
    count: number;
    onOpen?: () => void;
    onDelete: () => void;
    onCut?: () => void;
    onCopy?: () => void;
    onCopyRelativePaths?: () => void;
  };
  onClose: () => void;
  position: { x: number; y: number };
}

const MENU_WIDTH = 220;
const ITEM_HEIGHT = 32;
const PADDING = 6;

export function WorkspaceFileContextMenu({
  absolutePath,
  canOpenFile = true,
  entryActions,
  selectionActions,
  onClose,
  position,
}: WorkspaceFileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const hasElectronFileActions = canUseElectronFileActions();
  const revealLabel = getRevealFileLabel(getElectronPlatform());
  const itemCount = selectionActions
    ? 1 + (selectionActions.onOpen ? 1 : 0) + (selectionActions.onCut ? 1 : 0)
      + (selectionActions.onCopy ? 1 : 0) + (selectionActions.onCopyRelativePaths ? 1 : 0)
    : (hasElectronFileActions ? 2 : 0) + 1
      + (entryActions
        ? 2 + [
          entryActions.onCut, entryActions.onCopy, entryActions.onPaste, entryActions.onDuplicate,
          entryActions.onCopyRelativePath, entryActions.onOpenTerminal, entryActions.onExpandChildren, entryActions.onCollapseChildren,
          entryActions.onRename, entryActions.onDelete,
        ].filter(Boolean).length
        : 0);
  const separatorCount = selectionActions ? 1 : 4;

  useCloseOnEscape(onClose, { capture: true });

  const menuPos = useMemo(() => {
    if (typeof window === "undefined") return null;

    const menuHeight = ITEM_HEIGHT * itemCount + PADDING * 2 + separatorCount * 9;
    let top = position.y;
    let left = position.x;

    if (top + menuHeight > window.innerHeight - 8) {
      top = window.innerHeight - menuHeight - 8;
    }
    if (left + MENU_WIDTH > window.innerWidth - 8) {
      left = window.innerWidth - MENU_WIDTH - 8;
    }

    return {
      left: Math.max(8, left),
      top: Math.max(8, top),
    };
  }, [itemCount, position.x, position.y, separatorCount]);

  useEffect(() => {
    function onMouseDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [onClose]);

  useEffect(() => {
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
    firstItem?.focus();
  }, []);

  const handleMenuKeyDown = useMenuNavigation(menuRef, '[role="menuitem"]:not(:disabled)');

  const handleOpen = useCallback(() => {
    if (!canOpenFile) return;
    openFilePathOnHost(absolutePath);
    onClose();
  }, [absolutePath, canOpenFile, onClose]);

  const handleReveal = useCallback(() => {
    revealFilePathOnHost(absolutePath);
    onClose();
  }, [absolutePath, onClose]);

  const handleCopyPath = useCallback(() => {
    copyText(absolutePath);
    onClose();
  }, [absolutePath, onClose]);

  const menuItemClassName = cn(
    "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-[12px]",
    "text-(--sidebar-text-active) transition-colors",
    "hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none",
  );
  const disabledItemClassName = cn(
    "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-[12px]",
    "text-(--text-muted) opacity-50",
  );
  const destructiveItemClassName = cn(
    "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-[12px]",
    "text-(--status-error-text) transition-colors",
    "hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none",
  );
  const separator = <div className="my-1 h-px bg-(--divider) opacity-40" />;
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  if (typeof document === "undefined" || !menuPos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="File options"
      className={cn(
        "fixed z-[9999] rounded-lg border border-(--divider) bg-(--sidebar-bg) p-1.5",
        "shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]",
      )}
      style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
      onKeyDown={handleMenuKeyDown}
      data-testid="workspace-file-context-menu"
    >
      {selectionActions ? (
        <>
          {selectionActions.onOpen ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(selectionActions.onOpen)} data-testid="workspace-context-open-selected">
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span>Open selected files</span>
            </button>
          ) : null}
          {selectionActions.onCut ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(selectionActions.onCut)} data-testid="workspace-context-cut-selected">
              <Scissors className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <span>Cut {selectionActions.count} selected items</span>
            </button>
          ) : null}
          {selectionActions.onCopy ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(selectionActions.onCopy)} data-testid="workspace-context-copy-selected">
              <Copy className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <span>Copy {selectionActions.count} selected items</span>
            </button>
          ) : null}
          {selectionActions.onCopyRelativePaths ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(selectionActions.onCopyRelativePaths)} data-testid="workspace-context-copy-relative-paths">
              <Link2 className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <span>Copy relative paths</span>
            </button>
          ) : null}
          {separator}
          <button type="button" role="menuitem" className={destructiveItemClassName}
            onClick={run(selectionActions.onDelete)} data-testid="workspace-context-delete-selected">
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>Delete {selectionActions.count} selected items</span>
          </button>
        </>
      ) : <>
      {entryActions ? (
        <>
          <button
            {...telemetryClickAttributes('workspace_editor.context.new_file', 'workspace_editor')}
            type="button"
            role="menuitem"
            className={menuItemClassName}
            onClick={run(entryActions.onNewFile)}
            data-testid="workspace-context-new-file"
          >
            <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>New file</span>
          </button>
          <button
            {...telemetryClickAttributes('workspace_editor.context.new_folder', 'workspace_editor')}
            type="button"
            role="menuitem"
            className={menuItemClassName}
            onClick={run(entryActions.onNewFolder)}
            data-testid="workspace-context-new-folder"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>New folder</span>
          </button>
          {separator}
        </>
      ) : null}
      {entryActions && (entryActions.onCut || entryActions.onCopy || entryActions.onPaste || entryActions.onDuplicate) ? (
        <>
          {entryActions.onCut ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(entryActions.onCut)} data-testid="workspace-context-cut">
              <Scissors className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <span>Cut</span>
            </button>
          ) : null}
          {entryActions.onCopy ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(entryActions.onCopy)} data-testid="workspace-context-copy">
              <Copy className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <span>Copy</span>
            </button>
          ) : null}
          {entryActions.onPaste ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(entryActions.onPaste)} data-testid="workspace-context-paste">
              <ClipboardPaste className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <span>Paste</span>
            </button>
          ) : null}
          {entryActions.onDuplicate ? (
            <button type="button" role="menuitem" className={menuItemClassName}
              onClick={run(entryActions.onDuplicate)} data-testid="workspace-context-duplicate">
              <CopyPlus className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <span>Duplicate</span>
            </button>
          ) : null}
          {separator}
        </>
      ) : null}
      {hasElectronFileActions ? (
        <>
          <button
            {...telemetryClickAttributes('workspace_editor.context.open', 'workspace_editor')}
            type="button"
            role="menuitem"
            className={canOpenFile ? menuItemClassName : disabledItemClassName}
            onClick={canOpenFile ? handleOpen : undefined}
            disabled={!canOpenFile}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Open</span>
          </button>
          <button
            {...telemetryClickAttributes('workspace_editor.context.reveal', 'workspace_editor')}
            type="button"
            role="menuitem"
            className={menuItemClassName}
            onClick={handleReveal}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>{revealLabel}</span>
          </button>
          <div className="my-1 h-px bg-(--divider) opacity-40" />
        </>
      ) : null}
      <button
        {...telemetryClickAttributes('workspace_editor.context.copy_path', 'workspace_editor')}
        type="button"
        role="menuitem"
        className={menuItemClassName}
        onClick={handleCopyPath}
      >
        <Copy className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
        <span>Copy absolute path</span>
      </button>
      {entryActions?.onCopyRelativePath ? (
        <button type="button" role="menuitem" className={menuItemClassName}
          onClick={run(entryActions.onCopyRelativePath)} data-testid="workspace-context-copy-relative-path">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <span>Copy relative path</span>
        </button>
      ) : null}
      {entryActions?.onOpenTerminal ? (
        <button type="button" role="menuitem" className={menuItemClassName}
          onClick={run(entryActions.onOpenTerminal)} data-testid="workspace-context-open-terminal">
          <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <span>Open in terminal</span>
        </button>
      ) : null}
      {entryActions?.onExpandChildren ? (
        <button type="button" role="menuitem" className={menuItemClassName}
          onClick={run(entryActions.onExpandChildren)} data-testid="workspace-context-expand-children">
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <span>Expand all subfolders</span>
        </button>
      ) : null}
      {entryActions?.onCollapseChildren ? (
        <button type="button" role="menuitem" className={menuItemClassName}
          onClick={run(entryActions.onCollapseChildren)} data-testid="workspace-context-collapse-children">
          <ChevronsDownUp className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <span>Collapse all subfolders</span>
        </button>
      ) : null}
      {entryActions?.onRename || entryActions?.onDelete ? separator : null}
      {entryActions?.onRename ? (
        <button
          {...telemetryClickAttributes('workspace_editor.context.rename', 'workspace_editor')}
          type="button"
          role="menuitem"
          className={menuItemClassName}
          onClick={run(entryActions.onRename)}
          data-testid="workspace-context-rename"
        >
          <PenLine className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <span>Rename</span>
        </button>
      ) : null}
      {entryActions?.onDelete ? (
        <button
          {...telemetryClickAttributes('workspace_editor.context.delete', 'workspace_editor')}
          type="button"
          role="menuitem"
          className={destructiveItemClassName}
          onClick={run(entryActions.onDelete)}
          data-testid="workspace-context-delete"
        >
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
          <span>Delete</span>
        </button>
      ) : null}
      </>}
    </div>,
    document.body,
  );
}
