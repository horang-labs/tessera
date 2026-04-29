"use client";

import { useEffect, useState } from "react";
import { WorkspaceCodeView } from "@/components/workspace/workspace-code-view";
import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import { usePanelStore, selectActiveTab, EMPTY_PANELS } from "@/stores/panel-store";
import type { GitDiffData } from "@/types/git";
import type { WorkspaceFileData } from "@/types/workspace-file";
import type { WorkspaceFileSessionRef } from "@/lib/workspace-tabs/special-session";

interface WorkspaceFileTabState {
  loading: boolean;
  error: string | null;
  data: WorkspaceFileData | GitDiffData | null;
}

function getFileUrl(ref: WorkspaceFileSessionRef): string {
  const sessionId = encodeURIComponent(ref.sourceSessionId);
  const path = encodeURIComponent(ref.path);
  if (ref.kind === "diff") return `/api/sessions/${sessionId}/git/diff?path=${path}`;
  return `/api/sessions/${sessionId}/file?path=${path}`;
}

export function WorkspaceFileTab({
  fileRef,
  panelId,
}: {
  fileRef: WorkspaceFileSessionRef;
  panelId: string;
}) {
  const { kind, path, sourceSessionId } = fileRef;
  const panelCount = usePanelStore(
    (state) => Object.keys(selectActiveTab(state)?.panels ?? EMPTY_PANELS).length,
  );
  const closePanel = usePanelStore((state) => state.closePanel);
  const assignSession = usePanelStore((state) => state.assignSession);
  const [state, setState] = useState<WorkspaceFileTabState>({
    loading: true,
    error: null,
    data: null,
  });

  useEffect(() => {
    const abortController = new AbortController();

    const loadFile = async () => {
      try {
        const response = await fetch(getFileUrl({ type: "workspace-file", sourceSessionId, kind, path }), {
          signal: abortController.signal,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(extractGitPanelErrorMessage(payload, "Failed to load file."));
        }
        setState({
          loading: false,
          error: null,
          data: payload as WorkspaceFileData | GitDiffData,
        });
      } catch (error) {
        if (abortController.signal.aborted) return;
        setState({
          loading: false,
          error: error instanceof Error ? error.message : "Failed to load file.",
          data: null,
        });
      }
    };

    void loadFile();
    return () => abortController.abort();
  }, [kind, path, sourceSessionId]);

  return (
    <WorkspaceCodeView
      data={state.data}
      error={state.error}
      loading={state.loading}
      mode={fileRef.kind}
      onClose={() => {
        if (panelCount >= 2) {
          closePanel(panelId);
        } else {
          assignSession(panelId, null);
        }
      }}
      path={fileRef.path}
    />
  );
}
