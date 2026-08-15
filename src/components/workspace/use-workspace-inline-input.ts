"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveInlineSubmitIntent,
  type WorkspaceInlineInput,
} from "@/components/workspace/workspace-inline-input-state";

interface WorkspaceInlineInputHandlers {
  onCreateFile: (path: string) => Promise<void>;
  onCreateFolder: (path: string) => Promise<void>;
  /** Opens the folder a placeholder row is about to appear inside. */
  onExpandParent: (parentPath: string) => void;
  /** A file-list reload the panel held back while an input was open. */
  onRefreshFiles: () => void;
  onRename: (path: string, newName: string) => Promise<void>;
  /** The workspace the open input belongs to. Changing it abandons the input. */
  workspaceKey: string | null;
}

interface OpenedInlineInput {
  input: WorkspaceInlineInput;
  workspaceKey: string | null;
}

export interface WorkspaceInlineInputController {
  cancel: () => void;
  error: string | null;
  /**
   * The panel's live-sync refresh, gated: a reconcile that lands while a row is
   * being edited would take the row — and the half-typed name — with it.
   */
  handleExternalRefresh: () => void;
  input: WorkspaceInlineInput | null;
  isRenaming: (path: string) => boolean;
  /** The folder a placeholder row belongs to, or null when none is open. */
  newEntryParent: string | null;
  startNew: (kind: "file" | "folder", parentPath: string) => void;
  startRename: (target: { isDirectory: boolean; name: string; path: string }) => void;
  submit: (value: string) => void;
  submitting: boolean;
}

/**
 * The File Explorer's inline name entry: idle → entering-new / editing-existing
 * → submitting → error-or-idle. Ported from Orca's `useFileExplorerInlineInput`,
 * minus the undo/redo stack, which is out of scope.
 *
 * A failed submit keeps the input open with the server's message beside it, so
 * a duplicate name can be corrected where it was typed rather than in a modal.
 */
export function useWorkspaceInlineInput(
  handlers: WorkspaceInlineInputHandlers,
): WorkspaceInlineInputController {
  // The workspace the input was opened against travels with it. The panel
  // outlives a session switch, and an input left over from the last workspace
  // has no row to sit on: it would create at the new root, or — worse — hold
  // this panel's watch refresh back for good. Deriving it rather than resetting
  // it in an effect keeps that impossible instead of merely handled.
  const [opened, setOpened] = useState<OpenedInlineInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const input = opened && opened.workspaceKey === handlers.workspaceKey ? opened.input : null;
  // The refs carry what the callbacks need without re-creating them on every
  // render of the panel, which would remount the input and lose its focus.
  const handlersRef = useRef(handlers);
  const openedRef = useRef<OpenedInlineInput | null>(null);
  const submittingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  // Bumped whenever the open input changes. A blur commits synchronously and
  // the next input can open while that request is still out; without this its
  // late reply would close the new input, or hang the old input's error on it.
  const generationRef = useRef(0);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  const close = useCallback(() => {
    generationRef.current += 1;
    openedRef.current = null;
    submittingRef.current = false;
    setOpened(null);
    setError(null);
    setSubmitting(false);
    // Whatever the watcher reported while the input was open is applied now,
    // in one reload, rather than being dropped.
    if (pendingRefreshRef.current) {
      pendingRefreshRef.current = false;
      handlersRef.current.onRefreshFiles();
    }
  }, []);

  const open = useCallback((next: WorkspaceInlineInput) => {
    const entry = { input: next, workspaceKey: handlersRef.current.workspaceKey };
    generationRef.current += 1;
    openedRef.current = entry;
    submittingRef.current = false;
    setOpened(entry);
    setError(null);
    setSubmitting(false);
  }, []);

  const startNew = useCallback((kind: "file" | "folder", parentPath: string) => {
    if (parentPath) handlersRef.current.onExpandParent(parentPath);
    open({ kind: kind === "folder" ? "new-folder" : "new-file", parentPath });
  }, [open]);

  const startRename = useCallback(
    (target: { isDirectory: boolean; name: string; path: string }) =>
      open({ kind: "rename", ...target }),
    [open],
  );

  const submit = useCallback((value: string) => {
    const current = openedRef.current;
    if (!current || current.workspaceKey !== handlersRef.current.workspaceKey) return;
    if (submittingRef.current) return;

    const intent = resolveInlineSubmitIntent(current.input, value);
    if (intent.kind === "cancel") {
      close();
      return;
    }

    const generation = generationRef.current;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        if (intent.kind === "create-file") {
          await handlersRef.current.onCreateFile(intent.path);
        } else if (intent.kind === "create-folder") {
          await handlersRef.current.onCreateFolder(intent.path);
        } else {
          await handlersRef.current.onRename(intent.path, intent.newName);
        }
        // Only if this is still the input that was submitted: another row may
        // have taken over while the request was out, and closing it or
        // reporting into it would be reporting about someone else's name.
        if (generationRef.current === generation) close();
      } catch (caught) {
        if (generationRef.current !== generation) return;
        submittingRef.current = false;
        setSubmitting(false);
        setError(caught instanceof Error ? caught.message : "That did not work.");
      }
    })();
  }, [close]);

  const handleExternalRefresh = useCallback(() => {
    const current = openedRef.current;
    // Only an input for *this* workspace holds the reload back. One left from a
    // session that is no longer shown must not stop the panel updating.
    if (current && current.workspaceKey === handlersRef.current.workspaceKey) {
      pendingRefreshRef.current = true;
      return;
    }
    handlersRef.current.onRefreshFiles();
  }, []);

  const isRenaming = useCallback(
    (path: string) => input?.kind === "rename" && input.path === path,
    [input],
  );

  return {
    cancel: close,
    error,
    handleExternalRefresh,
    input,
    isRenaming,
    newEntryParent: input && input.kind !== "rename" ? input.parentPath : null,
    startNew,
    startRename,
    submit,
    submitting,
  };
}
