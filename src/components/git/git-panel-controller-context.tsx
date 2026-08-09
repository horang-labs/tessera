"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useGitPanelController } from "./use-git-panel-controller";
import { GitDefaultBranchConfirmDialog } from "./git-default-branch-confirm-dialog";

export type GitPanelController = ReturnType<typeof useGitPanelController>;

const GitPanelControllerContext = createContext<GitPanelController | null>(null);

export function GitPanelControllerProvider({
  children,
  sessionId,
}: {
  children: ReactNode;
  sessionId: string | null;
}) {
  const controller = useGitPanelController(sessionId);
  return (
    <GitPanelControllerContext.Provider value={controller}>
      {children}
      <GitDefaultBranchConfirmDialog
        confirmation={controller.pushConfirmation}
        onCancel={controller.cancelPrimaryAction}
        onConfirm={() => void controller.confirmPrimaryAction()}
      />
    </GitPanelControllerContext.Provider>
  );
}

export function useSharedGitPanelController(): GitPanelController {
  const controller = useContext(GitPanelControllerContext);
  if (!controller) {
    throw new Error("Git surfaces must be rendered inside GitPanelControllerProvider");
  }
  return controller;
}
