"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import { openWorkspaceFileTab } from "@/lib/workspace-tabs/open-workspace-tab";

const CREATE_TIMEOUT_MS = 3_000;

export function WorkspaceNewFileDialog({
  /** Pre-filled folder, workspace-relative and without a trailing slash. */
  directory,
  onOpenChange,
  open,
  sessionId,
}: {
  directory?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  sessionId: string;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const prefix = directory && directory !== "." ? `${directory.replace(/\/+$/, "")}/` : "";
    setValue(prefix);
    setError(null);
    setCreating(false);
    // Focus lands after the value is set so the caret sits past the folder.
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      const end = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(end, end);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [directory, open]);

  async function createFile() {
    const requestedPath = value.trim();
    if (!requestedPath || creating) return;

    setCreating(true);
    setError(null);
    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(sessionId)}/file`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: requestedPath, content: "" }),
          timeoutMs: CREATE_TIMEOUT_MS,
        },
      );
      const payload = await response.json().catch(() => null) as
        | { path?: string; error?: { code?: string; message?: string } }
        | null;
      if (!response.ok || !payload?.path) {
        throw new Error(extractGitPanelErrorMessage(payload, "Failed to create file."));
      }

      onOpenChange(false);
      openWorkspaceFileTab(sessionId, "file", payload.path);
    } catch (caught) {
      setError(
        isTimeoutError(caught)
          ? "The file was not created in time. The workspace filesystem may be unresponsive."
          : caught instanceof Error ? caught.message : "Failed to create file.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="dialog-title" data-testid="workspace-new-file-dialog">
        <DialogHeader onClose={() => onOpenChange(false)}>
          <DialogTitle>New file</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createFile();
          }}
        >
          <label className="block text-xs text-(--text-muted)" htmlFor="workspace-new-file-path">
            Path, relative to the workspace root
          </label>
          <input
            ref={inputRef}
            id="workspace-new-file-path"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder="notes/todo.md"
            autoComplete="off"
            spellCheck={false}
            className="mt-2 h-9 w-full rounded-md border border-(--input-border) bg-(--chat-bg) px-3 font-mono text-sm text-(--text-primary) outline-none focus:border-(--accent)"
            data-testid="workspace-new-file-input"
          />
          {error ? (
            <p className="mt-2 text-xs text-(--status-error-text)" data-testid="workspace-new-file-error">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!value.trim() || creating}
              data-testid="workspace-new-file-submit"
            >
              {creating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
              <span>Create</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
