"use client";

import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { GitPrimaryAction } from "@/lib/git/primary-git-action";

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
  pending,
  blocked,
  onRun,
}: {
  action: GitPrimaryAction;
  pending: boolean;
  /**
   * The surface around the button refusing it for something the ladder cannot
   * see — an empty commit message, a selection the user emptied.
   */
  blocked?: boolean;
  onRun: () => void;
}) {
  const { t } = useI18n();
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
      {pending ? (
        <>
          <LoaderCircle className="mr-1.5 h-3 w-3 animate-spin" />
          {t(action.pendingLabelKey)}
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
  pending,
  onRun,
}: {
  action: GitPrimaryAction;
  pending: boolean;
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
      <GitPrimaryActionButton action={action} pending={pending} onRun={onRun} />
    </div>
  );
}
