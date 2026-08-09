"use client";

import { AlertTriangle } from "lucide-react";
import { createPortal } from "react-dom";
import { AsyncConfirmDialog } from "@/components/ui/async-confirm-dialog";
import { Button } from "@/components/ui/button";
import { DialogHero } from "@/components/ui/dialog-hero";
import { useCloseOnEscape } from "@/hooks/use-close-on-escape";
import { usePhoneOverlayNavigation } from "@/hooks/use-phone-overlay-navigation";
import { usePhoneViewport } from "@/hooks/use-phone-viewport";
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

    return createPortal(
      <div
        className="fixed inset-0 z-[70] flex items-end bg-black/60 backdrop-blur-sm"
        data-testid="git-default-branch-confirm-sheet-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) dismissPhoneConfirmation();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-testid="git-default-branch-confirm-sheet"
          className="max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] w-full overflow-y-auto rounded-t-2xl border border-b-0 border-(--divider) bg-(--sidebar-bg) px-4 pt-3 shadow-2xl"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-(--text-muted)/40" />
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
              className="min-h-[44px] w-full"
              data-testid="git-default-branch-confirm-accept"
            >
              {confirmLabel}
            </Button>
            <Button
              type="button"
              onClick={() => dismissPhoneConfirmation()}
              variant="outline"
              className="min-h-[44px] w-full"
              data-testid="git-default-branch-confirm-cancel"
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      </div>,
      document.body,
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
