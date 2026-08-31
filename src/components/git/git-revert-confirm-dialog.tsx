"use client";

import { Undo2 } from "lucide-react";
import { AsyncConfirmDialog } from "@/components/ui/async-confirm-dialog";
import { Button } from "@/components/ui/button";
import { DialogHero } from "@/components/ui/dialog-hero";
import { PhoneBottomSheet } from "@/components/ui/phone-bottom-sheet";
import { useCloseOnEscape } from "@/hooks/use-close-on-escape";
import { usePhoneOverlayNavigation } from "@/hooks/use-phone-overlay-navigation";
import { usePhoneViewport } from "@/hooks/use-phone-viewport";
import { useI18n } from "@/lib/i18n";
import { canRevertFile } from "@/lib/git/revert-eligibility";
import { telemetryClickAttributes } from "@/lib/telemetry/ui-click";
import type { GitChangedFile } from "@/types/git";

/**
 * The question asked before reverting the selected changed files.
 *
 * The selection is the same checkbox list the commit uses, so "these files"
 * means the same set to both actions. The body explains the split between
 * tracked restores and untracked deletions, because the two outcomes are not
 * the same and both are irreversible.
 */
export function GitRevertConfirmDialog({
  files,
  onCancel,
  onConfirm,
}: {
  /** The changed files chosen for revert; empty is the closed state. */
  files: readonly GitChangedFile[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const isPhoneViewport = usePhoneViewport();
  const open = files !== null && files.length > 0;
  const count = files?.length ?? 0;
  const hasUntracked = files?.some((file) => file.state === "untracked") ?? false;
  const hasTracked = files?.some((file) => canRevertFile(file) && file.state !== "untracked") ?? false;

  const dismissPhoneConfirmation = usePhoneOverlayNavigation({
    enabled: isPhoneViewport,
    open,
    onBack: onCancel,
  });
  useCloseOnEscape(dismissPhoneConfirmation, {
    enabled: isPhoneViewport && open,
    capture: true,
  });

  const title = count === 1
    ? t("gitPanel.revert.confirmTitleOne")
    : t("gitPanel.revert.confirmTitle", { count });
  const description = hasUntracked && hasTracked
    ? t("gitPanel.revert.confirmBodyMixed")
    : hasUntracked
      ? t("gitPanel.revert.confirmBodyUntracked")
      : t("gitPanel.revert.confirmBody");
  const confirmLabel = count === 1
    ? t("gitPanel.revert.confirmOne")
    : t("gitPanel.revert.confirm", { count });

  if (isPhoneViewport) {
    if (!open || typeof document === "undefined") return null;

    return (
      <PhoneBottomSheet
        role="dialog"
        ariaLabel={title}
        backdropTestId="git-revert-confirm-sheet-backdrop"
        sheetTestId="git-revert-confirm-sheet"
        className="px-4 pt-3"
        handleClassName="mb-4"
        onDismiss={dismissPhoneConfirmation}
      >
        <DialogHero
          title={title}
          icon={Undo2}
          iconContainerClassName="bg-(--error)/10"
          iconClassName="text-(--error)"
        />
        <p className="mb-4 mt-4 text-sm leading-6 text-(--text-primary)">
          {description}
        </p>
        <div className="mb-4 max-h-40 space-y-1 overflow-y-auto rounded-md border border-(--chat-header-border) bg-(--sidebar-bg)/60 px-3 py-2">
          {files?.map((file) => (
            <div key={file.path} className="truncate font-mono text-[11px] text-(--text-secondary)">
              {file.path}
            </div>
          ))}
        </div>
        <div className="grid gap-2">
          <Button
            type="button"
            onClick={() => dismissPhoneConfirmation(onConfirm)}
            {...telemetryClickAttributes("git.revert.confirm.accept", "git_panel")}
            className="min-h-[44px] w-full bg-(--error) text-white hover:bg-(--destructive-hover)"
            data-testid="git-revert-confirm-accept"
          >
            {confirmLabel}
          </Button>
          <Button
            type="button"
            onClick={() => dismissPhoneConfirmation()}
            {...telemetryClickAttributes("git.revert.confirm.cancel", "git_panel")}
            variant="outline"
            className="min-h-[44px] w-full"
            data-testid="git-revert-confirm-cancel"
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
      icon={Undo2}
      cancelLabel={t("common.cancel")}
      confirmLabel={confirmLabel}
      iconContainerClassName="bg-(--error)/10"
      iconClassName="text-(--error)"
      confirmButtonClassName="bg-(--error) text-white hover:bg-(--destructive-hover)"
      dialogTestId="git-revert-confirm-dialog"
      cancelTestId="git-revert-confirm-cancel"
      confirmTestId="git-revert-confirm-accept"
      errorLogLabel="Git revert error:"
      description={(
        <>
          <p className="text-(--text-primary)">{description}</p>
          <div className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-md border border-(--chat-header-border) bg-(--sidebar-bg)/60 px-3 py-2">
            {files?.map((file) => (
              <div key={file.path} className="truncate font-mono text-[11px] text-(--text-secondary)">
                {file.path}
              </div>
            ))}
          </div>
        </>
      )}
    />
  );
}
