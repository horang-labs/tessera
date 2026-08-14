"use client";

import { AlertTriangle } from "lucide-react";
import { AsyncConfirmDialog } from "@/components/ui/async-confirm-dialog";
import { Button } from "@/components/ui/button";
import { DialogHero } from "@/components/ui/dialog-hero";
import { PhoneBottomSheet } from "@/components/ui/phone-bottom-sheet";
import { useCloseOnEscape } from "@/hooks/use-close-on-escape";
import { usePhoneOverlayNavigation } from "@/hooks/use-phone-overlay-navigation";
import { usePhoneViewport } from "@/hooks/use-phone-viewport";
import { useI18n } from "@/lib/i18n";
import { telemetryClickAttributes } from "@/lib/telemetry/ui-click";
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
  const isPhoneViewport = usePhoneViewport();
  const open = confirmation !== null;
  const dismissPhoneConfirmation = usePhoneOverlayNavigation({
    enabled: isPhoneViewport,
    open,
    onBack: onCancel,
  });
  useCloseOnEscape(dismissPhoneConfirmation, {
    enabled: isPhoneViewport && open,
    capture: true,
  });

  const title = t(confirmation?.titleKey ?? "gitPanel.push.defaultBranchConfirm.title");
  const description = t(confirmation?.bodyKey ?? "gitPanel.push.defaultBranchConfirm.body", {
    branch: confirmation?.branch ?? "",
  });
  const confirmLabel = t(
    confirmation?.confirmLabelKey ?? "gitPanel.push.defaultBranchConfirm.confirm",
    { branch: confirmation?.branch ?? "" },
  );

  if (isPhoneViewport) {
    if (!open || typeof document === "undefined") return null;

    return (
      <PhoneBottomSheet
        role="dialog"
        ariaLabel={title}
        backdropTestId="git-default-branch-confirm-sheet-backdrop"
        sheetTestId="git-default-branch-confirm-sheet"
        className="px-4 pt-3"
        handleClassName="mb-4"
        onDismiss={dismissPhoneConfirmation}
      >
        <DialogHero
          title={title}
          icon={AlertTriangle}
          iconContainerClassName="bg-(--warning)/10"
          iconClassName="text-(--warning)"
        />
        <p className="mb-6 mt-4 text-sm leading-6 text-(--text-primary)">
          {description}
        </p>
        <div className="grid gap-2">
          <Button
            type="button"
            onClick={() => dismissPhoneConfirmation(onConfirm)}
            {...telemetryClickAttributes("git.default_branch_confirm.accept", "git_panel")}
            className="min-h-[44px] w-full"
            data-testid="git-default-branch-confirm-accept"
          >
            {confirmLabel}
          </Button>
          <Button
            type="button"
            onClick={() => dismissPhoneConfirmation()}
            {...telemetryClickAttributes("git.default_branch_confirm.cancel", "git_panel")}
            variant="outline"
            className="min-h-[44px] w-full"
            data-testid="git-default-branch-confirm-cancel"
          >
            {t("common.cancel")}
          </Button>
        </div>
      </PhoneBottomSheet>
    );
  }

  return (
    <AsyncConfirmDialog
      open={open}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={title}
      icon={AlertTriangle}
      cancelLabel={t("common.cancel")}
      confirmLabel={confirmLabel}
      iconContainerClassName="bg-(--warning)/10"
      iconClassName="text-(--warning)"
      dialogTestId="git-default-branch-confirm-dialog"
      cancelTestId="git-default-branch-confirm-cancel"
      confirmTestId="git-default-branch-confirm-accept"
      errorLogLabel="Git default-branch push error:"
      description={(
        <p className="text-(--text-primary)">
          {description}
        </p>
      )}
    />
  );
}
