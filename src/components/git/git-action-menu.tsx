"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { PhoneBottomSheet } from "@/components/ui/phone-bottom-sheet";
import { useAnchoredPopover } from "@/hooks/use-anchored-popover";
import { useCloseOnEscape } from "@/hooks/use-close-on-escape";
import { usePhoneOverlayNavigation } from "@/hooks/use-phone-overlay-navigation";
import { usePhoneViewport } from "@/hooks/use-phone-viewport";
import { useI18n } from "@/lib/i18n";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { cn } from "@/lib/utils";
import type { GitMenuAction, GitMenuActionId } from "@/lib/git/git-action-menu";
import {
  telemetryClickAttributes,
  type TelemetryUiControl,
} from "@/lib/telemetry/ui-click";

const GIT_MENU_TELEMETRY_CONTROLS: Record<GitMenuActionId, TelemetryUiControl> = {
  commit: "git.action.commit",
  commit_push: "git.action.commit_push",
  push: "git.action.push",
  pull: "git.action.pull",
  create_pr: "git.action.create_pr",
  open_source_control: "git.action.open_source_control",
  abort: "git.action.abort",
};

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
  onBeforeOpen,
  menuTestId = "git-action-menu",
  triggerAriaLabel,
  triggerClassName,
  triggerTestId = "git-action-menu-trigger",
}: {
  actions: readonly GitMenuAction[];
  /** An action is already running against this working directory. */
  pending: boolean;
  commitDraftBlocked: boolean;
  onRun: (id: GitMenuActionId) => void;
  onBeforeOpen?: () => void;
  menuTestId?: string;
  triggerAriaLabel?: string;
  triggerClassName?: string;
  triggerTestId?: string;
}) {
  const { t } = useI18n();
  const isPhoneViewport = usePhoneViewport();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const dismissPhoneMenu = usePhoneOverlayNavigation({
    enabled: isPhoneViewport,
    open,
    onBack: close,
  });
  const dismissMenu = useCallback(() => {
    if (isPhoneViewport) {
      return dismissPhoneMenu(() => triggerRef.current?.focus());
    }
    close();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [close, dismissPhoneMenu, isPhoneViewport]);
  useCloseOnEscape(dismissMenu, {
    enabled: open,
    capture: true,
  });
  const { position, updatePosition } = useAnchoredPopover({
    isOpen: open && !isPhoneViewport,
    onClose: close,
    triggerRef,
    containerRef,
    popoverRef: menuRef,
    calculatePosition: calculateMenuPosition,
  });
  const hasPosition = position !== null;
  useEffect(() => {
    if (!open || (!isPhoneViewport && !hasPosition)) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [hasPosition, isPhoneViewport, open]);
  const handleMenuKeyDown = useMenuNavigation(menuRef);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) {
            if (isPhoneViewport) return dismissPhoneMenu();
            return close();
          }
          onBeforeOpen?.();
          updatePosition();
          setOpen(true);
        }}
        {...telemetryClickAttributes("git.action_menu.open", "git_panel")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={pending}
        aria-label={triggerAriaLabel ?? t("gitPanel.menu.label")}
        title={pending
          ? t("gitPanel.menu.pending")
          : (triggerAriaLabel ?? t("gitPanel.menu.label"))}
        data-testid={triggerTestId}
        className={cn(
          "flex h-7 w-6 items-center justify-center rounded-md border border-(--divider) text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
          triggerClassName,
        )}
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

      {open && isPhoneViewport ? (
        <PhoneBottomSheet
          backdropTestId="git-action-menu-sheet-backdrop"
          sheetTestId="git-action-menu-sheet"
          className="px-2 pt-2"
          handleClassName="mb-2"
          onDismiss={dismissPhoneMenu}
        >
          <div
            ref={menuRef}
            role="menu"
            aria-label={triggerAriaLabel ?? t("gitPanel.menu.label")}
            data-testid={menuTestId}
            onKeyDown={handleMenuKeyDown}
          >
            <GitActionMenuItems
              actions={actions}
              commitDraftBlocked={commitDraftBlocked}
              pending={pending}
              touchSized
              onRun={(id) => dismissPhoneMenu(() => onRun(id))}
            />
          </div>
        </PhoneBottomSheet>
      ) : open && position ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={triggerAriaLabel ?? t("gitPanel.menu.label")}
          data-testid={menuTestId}
          onKeyDown={handleMenuKeyDown}
          style={{ position: "fixed", top: position.top, left: position.left, width: position.width }}
          className="z-50 overflow-hidden rounded-lg border border-(--divider) bg-(--sidebar-bg) py-1 shadow-lg"
        >
          <GitActionMenuItems
            actions={actions}
            commitDraftBlocked={commitDraftBlocked}
            pending={pending}
            onRun={(id) => {
              close();
              onRun(id);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function GitActionMenuItems({
  actions,
  commitDraftBlocked,
  pending,
  touchSized = false,
  onRun,
}: {
  actions: readonly GitMenuAction[];
  commitDraftBlocked: boolean;
  pending: boolean;
  touchSized?: boolean;
  onRun: (id: GitMenuActionId) => void;
}) {
  return actions.map((action) => (
    <GitActionMenuItem
      key={action.id}
      action={action}
      blocked={(action.id === "commit" || action.id === "commit_push")
        && commitDraftBlocked && action.enabled}
      pending={pending}
      touchSized={touchSized}
      onRun={() => onRun(action.id)}
    />
  ));
}

function GitActionMenuItem({
  action,
  blocked,
  pending,
  touchSized = false,
  onRun,
}: {
  action: GitMenuAction;
  blocked: boolean;
  pending: boolean;
  touchSized?: boolean;
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
      onClick={() => {
        if (!disabled) onRun();
      }}
      {...telemetryClickAttributes(GIT_MENU_TELEMETRY_CONTROLS[action.id], "git_panel")}
      aria-disabled={disabled}
      title={reason ?? undefined}
      data-testid={`git-action-menu-item-${action.id}`}
      data-git-action={action.kind}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left text-[11px] transition-colors",
        touchSized && "min-h-[44px] justify-center px-4 py-2.5",
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
