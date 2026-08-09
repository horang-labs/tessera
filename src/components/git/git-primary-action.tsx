"use client";

import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { GitPrimaryAction } from "@/lib/git/primary-git-action";
import type { GitPendingVerb } from "./use-git-panel-controller";

/**
 * What the button says while an action runs. Read off the verb that is actually
 * running rather than off the ladder, because the two can disagree: the menu can
 * start a push on a rung whose button says Pull, and a button that spent that
 * moment saying "Pulling…" would be naming an action nobody pressed — the same
 * thing ADR 0007 refuses for the resting label.
 */
export function resolvePendingLabelKey(
  action: GitPrimaryAction,
  verb: GitPendingVerb,
): string {
  if (verb === "commit") return "gitPanel.commit.buttonPending";
  if (verb === "commit_push") return "gitPanel.commitPush.buttonPending";
  if (verb === "pull") return "gitPanel.pull.buttonPending";
  if (verb === "create_pr") return "gitPanel.pr.createButtonPending";
  if (verb === "publish") return "gitPanel.push.publishButtonPending";
  // The abort is only ever started from the menu, and only ever on the conflict
  // rung, where this button is the one that cannot be pressed. It still holds
  // the spinner, because §7 puts progress at the button rather than in a toast.
  if (verb === "abort") return "gitPanel.conflict.abortPending";
  return action.kind === "publish"
    ? "gitPanel.push.publishButtonPending"
    : "gitPanel.push.buttonPending";
}

/**
 * The Git panel's one button (`docs/design/git-delivery.md` §3, ADR 0007).
 *
 * It carries whatever verb the ladder currently answers with and rotates as the
 * state changes; it never decides that itself. A disabled rung still renders as
 * the button rather than disappearing, so the panel keeps one stable frame
 * across a session switch instead of flashing through an action nobody pressed.
 */
export function GitPrimaryActionButton({
  action,
  pendingVerb,
  blocked,
  onRun,
}: {
  action: GitPrimaryAction;
  /**
   * The action running against this working directory, or null. It can be one
   * the menu started rather than one this button did, which is why the button
   * takes the verb rather than a boolean.
   */
  pendingVerb: GitPendingVerb | null;
  /**
   * The surface around the button refusing it for something the ladder cannot
   * see — an empty commit message, a selection the user emptied.
   */
  blocked?: boolean;
  onRun: () => void;
}) {
  const { t } = useI18n();
  const pending = pendingVerb !== null;
  const disabled = pending || blocked || !action.enabled;
  const reason = action.disabledReasonKey ? t(action.disabledReasonKey) : undefined;

  return (
    <Button
      type="button"
      size="sm"
      onClick={onRun}
      disabled={disabled}
      title={disabled ? reason : undefined}
      data-testid="git-primary-action-button"
      data-git-action={action.kind}
      className="h-7 shrink-0 px-3 text-[11px]"
    >
      {pendingVerb ? (
        <>
          <LoaderCircle className="mr-1.5 h-3 w-3 animate-spin" />
          {t(resolvePendingLabelKey(action, pendingVerb))}
        </>
      ) : (
        // The count rides on the label where the size of the operation is worth
        // seeing before pressing — `Pull (2)` (§4).
        t(action.labelKey, action.labelParams)
      )}
    </Button>
  );
}

/**
 * What the primary action looks like with no commit surface under it — the
 * clean-tree rungs, where there is no message to write and nothing to select.
 * The reason a disabled action gives is spelled out beside the button rather
 * than hidden in a tooltip, because on these rungs it is the only thing the
 * panel has to say.
 */
export function GitPrimaryActionBar({
  action,
  menu,
  pendingVerb,
  onRun,
}: {
  action: GitPrimaryAction;
  /**
   * The dropdown, which sits beside the button on every rung (§4) — including
   * the ones where the button itself cannot be pressed, since the whole point
   * of the menu is that it always offers the same list.
   */
  menu?: ReactNode;
  pendingVerb: GitPendingVerb | null;
  onRun: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-(--divider) bg-(--chat-bg) p-2">
      <span
        className="min-w-0 truncate text-[11px] text-(--text-muted)"
        data-testid="git-primary-action-reason"
      >
        {action.disabledReasonKey ? t(action.disabledReasonKey) : null}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <GitPrimaryActionButton
          action={action}
          pendingVerb={pendingVerb}
          onRun={onRun}
        />
        {menu}
      </div>
    </div>
  );
}
