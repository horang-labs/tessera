"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, FolderOpen } from "lucide-react";
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

interface WorkspaceFileContextMenuProps {
  absolutePath: string;
  canOpenFile?: boolean;
  onClose: () => void;
  position: { x: number; y: number };
}

const MENU_WIDTH = 220;
const ITEM_HEIGHT = 32;
const PADDING = 6;

export function WorkspaceFileContextMenu({
  absolutePath,
  canOpenFile = true,
  onClose,
  position,
}: WorkspaceFileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const hasElectronFileActions = canUseElectronFileActions();
  const revealLabel = getRevealFileLabel(getElectronPlatform());
  const itemCount = hasElectronFileActions ? 3 : 1;

  useCloseOnEscape(onClose, { capture: true });

  const menuPos = useMemo(() => {
    if (typeof window === "undefined") return null;

    const menuHeight = ITEM_HEIGHT * itemCount + PADDING * 2 + (hasElectronFileActions ? 1 : 0);
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
  }, [hasElectronFileActions, itemCount, position.x, position.y]);

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
      {hasElectronFileActions ? (
        <>
          <button
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
        type="button"
        role="menuitem"
        className={menuItemClassName}
        onClick={handleCopyPath}
      >
        <Copy className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
        <span>Copy absolute path</span>
      </button>
    </div>,
    document.body,
  );
}
