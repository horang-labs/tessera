"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { useAnchoredPopover } from "@/hooks/use-anchored-popover";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { GitMenuAction, GitMenuActionId } from "@/lib/git/git-action-menu";

/**
 * The dropdown beside the primary button (`docs/design/git-delivery.md` §4).
 *
 * It draws whatever the derivation hands it, in the order it is handed, and
 * decides nothing about availability itself — with one exception it is given
 * rather than infers: `commitDraftBlocked`, the message and the selection, which
 * are panel state the git-state derivation cannot see (§5). That is the same
 * seam the primary button's `blocked` prop sits on.
 *
 * A disabled entry stays in place and says why, rather than disappearing, so the
 * position of every action can be learned.
 */
export function GitActionMenu({
  actions,
  pending,
  commitDraftBlocked,
  onRun,
}: {
  actions: readonly GitMenuAction[];
  /** An action is already running against this working directory. */
  pending: boolean;
  commitDraftBlocked: boolean;
  onRun: (id: GitMenuActionId) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const { position, updatePosition } = useAnchoredPopover({
    isOpen: open,
    onClose: close,
    triggerRef,
    containerRef,
    popoverRef: menuRef,
    calculatePosition: calculateMenuPosition,
  });

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) return close();
          updatePosition();
          setOpen(true);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("gitPanel.menu.label")}
        title={pending ? t("gitPanel.menu.pending") : t("gitPanel.menu.label")}
        data-testid="git-action-menu-trigger"
        className="flex h-7 w-6 items-center justify-center rounded-md border border-(--divider) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
      >
        {/*
          Progress belongs at the button rather than in a toast (§7). A menu
          action has no button of its own to hold a pending label, so the
          trigger it came out of holds the spinner instead.
        */}
        {pending ? (
          <LoaderCircle className="h-3 w-3 animate-spin" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>

      {open && position ? (
        <div
          ref={menuRef}
          role="menu"
          data-testid="git-action-menu"
          style={{ position: "fixed", top: position.top, left: position.left, width: position.width }}
          className="z-50 overflow-hidden rounded-lg border border-(--divider) bg-(--sidebar-bg) py-1 shadow-lg"
        >
          {actions.map((action) => (
            <GitActionMenuItem
              key={action.id}
              action={action}
              blocked={
                (action.id === "commit" || action.id === "commit_push")
                && commitDraftBlocked
                // Only where the git state left the action available. An empty
                // draft is not the reason Commit cannot run on a session whose
                // state has not arrived, and saying so would send the user to
                // fix the one thing that is not in the way.
                && action.enabled
              }
              pending={pending}
              onRun={() => {
                close();
                onRun(action.id);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GitActionMenuItem({
  action,
  blocked,
  pending,
  onRun,
}: {
  action: GitMenuAction;
  blocked: boolean;
  pending: boolean;
  onRun: () => void;
}) {
  const { t } = useI18n();
  const disabled = pending || blocked || !action.enabled;
  // `blocked` only ever arrives on an action the git state left available, so
  // there is no competing reason for it to displace. The running action outranks
  // both: §4 asks a disabled entry to say why, and an entry greyed out with
  // nothing under it would be the one disable in the menu that stays silent.
  const reasonKey = pending
    ? "gitPanel.menu.pending"
    : blocked
      ? "gitPanel.commit.draftRequired"
      : action.disabledReasonKey;
  const reason = disabled && reasonKey ? t(reasonKey) : null;

  return (
    <button
      type="button"
      role="menuitem"
      onClick={onRun}
      disabled={disabled}
      title={reason ?? undefined}
      data-testid={`git-action-menu-item-${action.id}`}
      data-git-action={action.kind}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left text-[11px] transition-colors",
        disabled
          ? "cursor-not-allowed text-(--text-muted)"
          // §9's escape throws away whatever the operation had reached, and it
          // is the one entry here that does. Orca, whose conflict model this
          // adopts, marks it destructive for the same reason.
          : action.id === "abort"
            ? "text-(--status-error-text) hover:bg-(--sidebar-hover)"
            : "text-(--text-primary) hover:bg-(--sidebar-hover)",
      )}
    >
      <span className="w-full truncate font-medium">
        {/* The count rides on the label where the operation has a size (§4). */}
        {t(action.labelKey, action.labelParams)}
      </span>
      {/*
        The reason is spelled out under the label rather than left to a tooltip:
        §4 asks a disabled action to say what would make it available, and a
        hint nobody hovers over says nothing.
      */}
      {reason ? (
        <span className="w-full truncate text-[10px] text-(--text-muted)">
          {reason}
        </span>
      ) : null}
    </button>
  );
}

interface GitActionMenuPosition {
  top: number;
  left: number;
  width: number;
}

/**
 * Under the trigger and right-aligned to it, pushed back inside the viewport
 * when the panel sits at the edge — and flipped above when there is no room
 * below, which is where the Git panel's own button lives on a short window.
 */
const MENU_WIDTH = 232;
const VIEWPORT_PADDING = 8;
/**
 * Roughly the tallest the menu gets: the five delivery entries, some carrying a
 * reason, plus §9's abort on the one rung that has it.
 */
const MENU_MAX_HEIGHT = 250;

function calculateMenuPosition(trigger: HTMLElement): GitActionMenuPosition {
  const rect = trigger.getBoundingClientRect();
  const below = rect.bottom + 4;
  const fitsBelow = below + MENU_MAX_HEIGHT <= window.innerHeight - VIEWPORT_PADDING;

  return {
    top: fitsBelow ? below : Math.max(VIEWPORT_PADDING, rect.top - MENU_MAX_HEIGHT - 4),
    left: Math.max(
      VIEWPORT_PADDING,
      Math.min(
        rect.right - MENU_WIDTH,
        window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING,
      ),
    ),
    width: MENU_WIDTH,
  };
}
