"use client";

import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

/**
 * The commit surface, inline above the changed-file list rather than in a
 * dialog: the panel already draws that list, and a dialog would draw it twice
 * (`docs/design/git-delivery.md` §5).
 *
 * The checkboxes that feed it live on the file rows themselves, always visible
 * — a working directory can be shared by several sessions, so confirming what
 * goes in is the normal case, not an advanced one.
 */
export function GitCommitForm({
  committing,
  message,
  onCommit,
  onMessageChange,
  totals,
}: {
  committing: boolean;
  message: string;
  onCommit: () => void;
  onMessageChange: (value: string) => void;
  totals: { files: number; added: number; removed: number };
}) {
  const { t } = useI18n();
  const canCommit = message.trim().length > 0 && totals.files > 0 && !committing;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-(--divider) bg-(--chat-bg) p-2">
      <textarea
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        disabled={committing}
        rows={2}
        aria-label={t("gitPanel.commit.messageLabel")}
        placeholder={t("gitPanel.commit.messagePlaceholder")}
        data-testid="git-commit-message"
        className="min-h-[3.5rem] w-full resize-y rounded-md border border-(--divider) bg-(--sidebar-bg) px-2 py-1.5 text-[12px] leading-5 text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent) disabled:opacity-60"
      />
      <div className="flex items-center justify-between gap-2">
        <span
          className="min-w-0 truncate font-mono text-[10px] text-(--text-muted) tabular-nums"
          data-testid="git-commit-selection-summary"
        >
          {t("gitPanel.commit.selectionSummary", { files: totals.files })}
          {totals.added > 0 || totals.removed > 0 ? (
            <>
              {" · "}
              <span className="text-(--status-success-text)">+{totals.added}</span>
              {" "}
              <span className="text-(--status-error-text)">-{totals.removed}</span>
            </>
          ) : null}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={onCommit}
          disabled={!canCommit}
          data-testid="git-commit-button"
          className="h-7 shrink-0 px-3 text-[11px]"
        >
          {committing ? (
            <>
              <LoaderCircle className="mr-1.5 h-3 w-3 animate-spin" />
              {t("gitPanel.commit.buttonPending")}
            </>
          ) : (
            t("gitPanel.commit.button")
          )}
        </Button>
      </div>
    </div>
  );
}
