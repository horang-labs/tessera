"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, Copy, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  GIT_FAILURE_TITLE_KEY,
  type GitActionFailureReport,
} from "./git-action-report";

function GitFailureOutput({ label, text }: { label: string; text: string }) {
  if (!text.trim()) return null;

  return (
    <div className="mt-1.5">
      <p className="text-[10px] uppercase tracking-[0.16em] text-(--text-muted)">
        {label}
      </p>
      <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-(--divider) bg-(--sidebar-bg) px-2 py-1.5 font-mono text-[10px] leading-4 text-(--text-secondary)">
        {text.trimEnd()}
      </pre>
    </div>
  );
}

/**
 * What a failed Git action leaves behind in the panel (#248).
 *
 * It sits under the primary action because that is what was pressed, and it
 * stays until the user dismisses it or starts something else — the toast beside
 * it says the same first line and is gone in seconds, which is how the reported
 * incident ended up with a user who could not tell what had failed, or that
 * anything had.
 *
 * The expandable half is the point: `summarizeGitFailure` keeps one line, and
 * for a push refused over its upstream, or a hook that narrated before it
 * refused, the sentence that explains it is somewhere else in the output.
 */
export function GitActionFailureBanner({
  report,
  onDismiss,
}: {
  report: GitActionFailureReport;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // A kind this build has no wording for is quoted instead of summarized, so
  // whatever the server sent still reaches the user (#248).
  const summary = report.summary
    ? t(report.summary.messageKey, report.summary.params)
    : report.message.trim();
  const hasOutput = Boolean(report.stderr.trim() || report.stdout.trim());
  const hasDetails = hasOutput || report.exitCode !== null;

  return (
    <div
      className="shrink-0 rounded-xl border border-[#c94c4c]/30 bg-[#c94c4c]/10 p-2"
      data-testid="git-action-failure-banner"
      data-git-failure-verb={report.verb}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#c94c4c]" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-(--text-primary)">
            {t(GIT_FAILURE_TITLE_KEY[report.verb])}
          </p>
          <p
            className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-4 text-(--text-secondary)"
            data-testid="git-action-failure-summary"
          >
            {summary}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="-mr-0.5 -mt-0.5 shrink-0 rounded p-1 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
          aria-label={t("gitPanel.failure.dismiss")}
          title={t("gitPanel.failure.dismiss")}
          data-testid="git-action-failure-dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {hasDetails ? (
        <div className="mt-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-(--text-muted) transition-colors hover:text-(--text-primary)"
              data-testid="git-action-failure-toggle"
            >
              <ChevronDown
                className={cn(
                  "h-3 w-3 shrink-0 transition-transform",
                  expanded && "rotate-180",
                )}
              />
              {expanded
                ? t("gitPanel.failure.hideDetails")
                : t("gitPanel.failure.showDetails")}
            </button>
            {expanded && hasOutput ? (
              <button
                type="button"
                onClick={() => {
                  // Absent outside a secure context, where copying is simply
                  // unavailable rather than broken.
                  void navigator.clipboard?.writeText(
                    [report.stderr, report.stdout].filter(Boolean).join("\n"),
                  );
                }}
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-(--text-muted) transition-colors hover:text-(--text-primary)"
                aria-label={t("gitPanel.failure.copyOutput")}
                title={t("gitPanel.failure.copyOutput")}
                data-testid="git-action-failure-copy"
              >
                <Copy className="h-3 w-3" />
              </button>
            ) : null}
          </div>

          {expanded ? (
            <div data-testid="git-action-failure-details">
              <p className="mt-1 font-mono text-[10px] text-(--text-muted)">
                {report.exitCode === null
                  ? t("gitPanel.failure.exitCodeUnknown")
                  : t("gitPanel.failure.exitCode", { code: report.exitCode })}
              </p>
              <GitFailureOutput
                label={t("gitPanel.failure.stderrLabel")}
                text={report.stderr}
              />
              <GitFailureOutput
                label={t("gitPanel.failure.stdoutLabel")}
                text={report.stdout}
              />
              {hasOutput ? null : (
                <p className="mt-1 text-[10px] text-(--text-muted)">
                  {t("gitPanel.failure.noOutput")}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
