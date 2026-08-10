"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface WorkspaceDeleteRequest {
  /** Workspace-relative path of the entry to delete. */
  path: string;
  kind: "file" | "directory";
  /** True when a tab has unsaved edits to this file. */
  dirty?: boolean;
}

/**
 * Confirm a permanent delete.
 *
 * There is no Trash to fall back on and no undo stack, so the dialog has to
 * say exactly what goes: the folder's contents, and any unsaved edits that
 * would be discarded along with the file.
 */
export function WorkspaceDeleteDialog({
  onConfirm,
  onOpenChange,
  request,
}: {
  onConfirm: (request: WorkspaceDeleteRequest) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  /** null when closed; the entry to delete otherwise. */
  request: WorkspaceDeleteRequest | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const open = request !== null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDeleting(false);
  }, [open]);

  async function confirm() {
    if (!request || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await onConfirm(request);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to delete.");
    } finally {
      setDeleting(false);
    }
  }

  const name = request ? request.path.split("/").pop() || request.path : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="dialog-title" data-testid="workspace-delete-dialog">
        <DialogHeader onClose={() => onOpenChange(false)}>
          <DialogTitle>
            {request?.kind === "directory" ? "Delete folder" : "Delete file"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-(--status-error-text)" />
          <div className="min-w-0 space-y-2">
            <p className="text-sm text-(--text-primary)">
              Delete <span className="font-mono">{name}</span>?
            </p>
            <p className="text-xs leading-5 text-(--text-muted)" data-testid="workspace-delete-detail">
              {request?.kind === "directory"
                ? "Everything inside this folder is deleted too."
                : "This file is deleted from the workspace."}
              {" "}
              This is permanent — it does not go to the Trash and cannot be undone.
              {request?.dirty
                ? " This file has unsaved edits, and they are discarded with it."
                : ""}
            </p>
            <p className="break-all font-mono text-[11px] text-(--text-muted)">{request?.path}</p>
          </div>
        </div>
        {error ? (
          <p className="mt-3 text-xs text-(--status-error-text)" data-testid="workspace-delete-error">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() => void confirm()}
            data-testid="workspace-delete-confirm"
          >
            {deleting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>Delete</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
