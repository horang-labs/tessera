"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

import { deleteWorkspaceSelection } from "@/lib/workspace-files/delete-workspace-selection";

export interface WorkspaceDeleteRequest {
  /** Workspace-relative path of the entry to delete. */
  path: string;
  kind: "file" | "directory";
  /** True when a tab has unsaved edits to this file. */
  dirty?: boolean;
}

/**
 * Confirm a delete.
 *
 * Where the OS has a trash for the workspace (`trashLabel` set) the default
 * sends the entry there; "Delete permanently" skips it. A workspace with none
 * (a WSL distro) only offers the permanent delete and says it cannot be undone.
 * Either way the dialog says exactly what goes: the folder's contents, and any
 * unsaved edits that would be discarded along with the file.
 */
export function WorkspaceDeleteDialog({
  onConfirm,
  onOpenChange,
  request,
  requests,
  trashLabel = null,
}: {
  onConfirm: (request: WorkspaceDeleteRequest, options: { permanent: boolean }) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  /** null when closed; the entry to delete otherwise. */
  request?: WorkspaceDeleteRequest | null;
  requests?: readonly WorkspaceDeleteRequest[] | null;
  /** The OS trash's name for this workspace, or null when deleting is permanent. */
  trashLabel?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const entries = requests ?? (request ? [request] : []);
  const open = entries.length > 0;
  // State, not a ref: it is read while rendering, and a ref reset in an effect
  // leaves the first render of a re-opened dialog holding the previous run's
  // deletions — so deleting a path a second time (after an undo, or after
  // creating a file of the same name) found nothing left to delete.
  const [completed, setCompleted] = useState<ReadonlySet<string>>(() => new Set());
  const remaining = entries.filter((entry) => !completed.has(entry.path));
  const multiple = entries.length > 1;
  const first = entries[0];

  useEffect(() => {
    if (!open) return;
    setCompleted(new Set());
    setError(null);
    setDeleting(false);
  }, [open, request, requests]);

  async function confirm(permanent: boolean) {
    if (!open || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteWorkspaceSelection(remaining, (entry) => onConfirm(entry, { permanent }));
      setCompleted((previous) => new Set([...previous, ...result.deleted]));
      if (result.failures.length) {
        setError(result.failures.map(({ path, message }) => `${path}: ${message}`).join("\n"));
      } else {
        onOpenChange(false);
      }
    } finally {
      setDeleting(false);
    }
  }

  function changeOpen(next: boolean) {
    if (!deleting) onOpenChange(next);
  }
  const name = first ? first.path.split("/").pop() || first.path : "";

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent aria-labelledby="dialog-title" data-testid="workspace-delete-dialog">
        <DialogHeader onClose={() => changeOpen(false)}>
          <DialogTitle>
            {multiple ? `Delete ${remaining.length} selected items` : first?.kind === "directory" ? "Delete folder" : "Delete file"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-(--status-error-text)" />
          <div className="min-w-0 space-y-2">
            <p className="text-sm text-(--text-primary)">
              {multiple ? `Delete these ${remaining.length} selected items?` : <>Delete <span className="font-mono">{name}</span>?</>}
            </p>
            <p className="text-xs leading-5 text-(--text-muted)" data-testid="workspace-delete-detail">
              {entries.some((entry) => entry.kind === "directory")
                ? multiple ? "All contents of the selected folders are deleted too." : "Everything inside this folder is deleted too."
                : multiple ? "These files are deleted from the workspace." : "This file is deleted from the workspace."}
              {" "}
              {trashLabel
                ? `It moves to the ${trashLabel}. Deleting permanently skips the ${trashLabel} and cannot be undone.`
                : "This is permanent — it does not go to the Trash and cannot be undone."}
              {entries.some((entry) => entry.dirty)
                ? " Unsaved edits in the selected items will be discarded."
                : ""}
            </p>
            <ul className="max-h-48 overflow-y-auto break-all font-mono text-[11px] text-(--text-muted)">
              {remaining.map((entry) => <li key={entry.path}>{entry.path}</li>)}
            </ul>
          </div>
        </div>
        {error ? (
          <p className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all text-xs text-(--status-error-text)" data-testid="workspace-delete-error">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            {...telemetryClickAttributes('workspace_editor.delete.cancel', 'workspace_editor')}
            type="button"
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          {trashLabel ? (
            <Button
              {...telemetryClickAttributes('workspace_editor.delete.permanent', 'workspace_editor')}
              type="button"
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={() => void confirm(true)}
              className="text-(--status-error-text)"
              data-testid="workspace-delete-permanent"
            >
              <span>Delete permanently</span>
            </Button>
          ) : null}
          <Button
            {...telemetryClickAttributes('workspace_editor.delete.confirm', 'workspace_editor')}
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() => void confirm(!trashLabel)}
            data-testid="workspace-delete-confirm"
          >
            {deleting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>{trashLabel ? `Move to ${trashLabel}` : "Delete"}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
