"use client";

import { AlertTriangle } from "lucide-react";
import { AsyncConfirmDialog } from "@/components/ui/async-confirm-dialog";
import { useI18n } from "@/lib/i18n";
import type { GitDefaultBranchConfirmation } from "@/lib/git/default-branch-confirmation";

/**
 * The question asked before a push reaches the repository's default branch
 * (`docs/design/git-delivery.md` §8).
 *
 * Two choices and no third: t3code offers "create a feature branch and run it
 * there", which needs a branch-creation action and a client-supplied ref, both
 * out of v1 scope. What the two say is assembled from the confirmation the
 * ladder handed over, so pushing and publishing do not share one fixed string.
 */
export function GitDefaultBranchConfirmDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  /** Null when there is nothing to ask about, which is also the closed state. */
  confirmation: GitDefaultBranchConfirmation | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return (
    <AsyncConfirmDialog
      open={confirmation !== null}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={t(confirmation?.titleKey ?? "gitPanel.push.defaultBranchConfirm.title")}
      icon={AlertTriangle}
      cancelLabel={t("common.cancel")}
      confirmLabel={t(
        confirmation?.confirmLabelKey ?? "gitPanel.push.defaultBranchConfirm.confirm",
        { branch: confirmation?.branch ?? "" },
      )}
      iconContainerClassName="bg-(--warning)/10"
      iconClassName="text-(--warning)"
      dialogTestId="git-default-branch-confirm-dialog"
      cancelTestId="git-default-branch-confirm-cancel"
      confirmTestId="git-default-branch-confirm-accept"
      errorLogLabel="Git default-branch push error:"
      description={(
        <p className="text-(--text-primary)">
          {t(confirmation?.bodyKey ?? "gitPanel.push.defaultBranchConfirm.body", {
            branch: confirmation?.branch ?? "",
          })}
        </p>
      )}
    />
  );
}
