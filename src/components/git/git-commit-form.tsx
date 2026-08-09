"use client";

import type { ReactNode } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { GitPrimaryAction } from "@/lib/git/primary-git-action";
import { GitPrimaryActionButton } from "./git-primary-action";
import type { GitPendingVerb } from "./use-git-panel-controller";

/**
 * The commit surface, inline above the changed-file list rather than in a
 * dialog: the panel already draws that list, and a dialog would draw it twice
 * (`docs/design/git-delivery.md` §5).
 *
 * The checkboxes that feed it live on the file rows themselves, always visible
 * — a working directory can be shared by several sessions, so confirming what
 * goes in is the normal case, not an advanced one.
 *
 * Generation is an explicit button that fills the field and never commits (§5),
 * and its failure is reported on the button rather than in a toast, so a model
 * that could not answer leaves the commit path exactly as it was.
 */
export function GitCommitForm({
  autoFocus = false,
  children,
  pendingVerb,
  generateError,
  generating,
  menu,
  message,
  onCommit,
  onGenerate,
  onMessageChange,
  primaryAction,
  totals,
}: {
  /** Focus only modal desktop composers; the phone panel deliberately opens without it. */
  autoFocus?: boolean;
  children?: ReactNode;
  /**
   * Whatever is running against this working directory, or null — not only this
   * form's own commit. A pull started from the menu holds the same `index.lock`
   * a commit would, so §7 disables these inputs for it too; leaving them live
   * would take a commit press the controller can only discard in silence.
   */
  pendingVerb: GitPendingVerb | null;
  generateError: string | null;
  generating: boolean;
  /** The dropdown, beside the button here as it is on every other rung (§4). */
  menu?: ReactNode;
  message: string;
  onCommit: () => void;
  onGenerate: () => void;
  onMessageChange: (value: string) => void;
  /**
   * Commit is a rung of the same ladder every other Git verb sits on, so the
   * button here is the panel's one primary button rather than a second one that
   * happens to say the same word.
   */
  primaryAction: GitPrimaryAction;
  totals: { files: number; added: number; removed: number };
}) {
  const { t } = useI18n();
  const busy = pendingVerb !== null;
  // What the ladder cannot see: a message still to be typed, a selection the
  // user emptied. §5 requires both, and this is the field-side half of it.
  const commitBlocked = message.trim().length === 0 || totals.files === 0;
  // Nothing selected means there is no change set to summarize, so the user is
  // never offered a summary of nothing.
  const canGenerate = totals.files > 0 && !generating && !busy;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-(--divider) bg-(--chat-bg) p-2">
      <textarea
        autoFocus={autoFocus}
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        disabled={busy || generating}
        rows={2}
        aria-label={t("gitPanel.commit.messageLabel")}
        placeholder={t("gitPanel.commit.messagePlaceholder")}
        data-testid="git-commit-message"
        className="min-h-[3.5rem] w-full resize-y rounded-md border border-(--divider) bg-(--sidebar-bg) px-2 py-1.5 text-[12px] leading-5 text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent) disabled:opacity-60"
      />
      {children}
      <div className="flex items-center justify-between gap-2">
        <span
          className="min-w-0 truncate font-mono text-[10px] text-(--text-muted) tabular-nums"
          data-testid="git-commit-selection-summary"
        >
          {generateError ? (
            <span
              className="text-(--status-error-text)"
              data-testid="git-commit-generate-error"
              title={generateError}
            >
              {t("gitPanel.commit.generateFailedPrefix", { reason: generateError })}
            </span>
          ) : (
            <>
              {t("gitPanel.commit.selectionSummary", { files: totals.files })}
              {totals.added > 0 || totals.removed > 0 ? (
                <>
                  {" · "}
                  <span className="text-(--status-success-text)">+{totals.added}</span>
                  {" "}
                  <span className="text-(--status-error-text)">-{totals.removed}</span>
                </>
              ) : null}
            </>
          )}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onGenerate}
          disabled={!canGenerate}
          aria-label={t("gitPanel.commit.generateLabel")}
          title={t("gitPanel.commit.generateLabel")}
          data-testid="git-commit-generate-button"
          className="h-7 shrink-0 px-2 text-[11px]"
        >
          {generating ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
        </Button>
        <GitPrimaryActionButton
          action={primaryAction}
          pendingVerb={pendingVerb}
          blocked={commitBlocked}
          onRun={onCommit}
        />
        {menu}
      </div>
    </div>
  );
}
