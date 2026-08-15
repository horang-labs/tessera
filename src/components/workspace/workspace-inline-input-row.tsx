"use client";

import { FilePlus2, FolderPlus, LoaderCircle, PenLine } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import {
  selectBaseNameRange,
  type WorkspaceInlineInput,
} from "@/components/workspace/workspace-inline-input-state";
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

const ICON_CLASS = "h-3.5 w-3.5 shrink-0 text-(--text-muted)";

/** Written out rather than picked into a variable: a component chosen during
 *  render is a new component type on every render, and resets its own state. */
function InlineInputIcon({ kind }: { kind: WorkspaceInlineInput["kind"] }) {
  if (kind === "new-folder") return <FolderPlus className={ICON_CLASS} />;
  if (kind === "new-file") return <FilePlus2 className={ICON_CLASS} />;
  return <PenLine className={ICON_CLASS} />;
}

/**
 * The row that replaces a name label (rename) or sits where a new entry will
 * land (create). It owns the focus lifecycle: focus after the row mounts, and
 * a rename opens with the extension left out of the selection.
 *
 * Enter commits, Esc abandons without a request, and a blur commits — the
 * behaviour of every file manager, and of Orca's `InlineInputRow`. An empty
 * value and an unchanged rename both resolve to "do nothing", so a stray blur
 * cannot create anything.
 *
 * The blur commits **synchronously**. Orca holds it behind a timer to survive
 * the focus shuffle its context menus cause; nothing here opens a menu, and a
 * held timer is worse than the problem: opening another row's input unmounts
 * this one, the cleanup takes the pending timer with it, and the name the user
 * typed disappears without a word.
 */
export function WorkspaceInlineInputRow({
  error,
  hint,
  indent,
  input,
  onCancel,
  onSubmit,
  submitting,
}: {
  error: string | null;
  /** Shown while there is no error: what committing this name costs. */
  hint?: string | null;
  /** Left padding in px, so the row lines up with the tree depth it belongs to. */
  indent: number;
  input: WorkspaceInlineInput;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  submitting: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const submittedRef = useRef(false);
  const initialValue = input.kind === "rename" ? input.name : "";

  // A refused name leaves the input open, so the next Enter has to be heard.
  useEffect(() => {
    if (error) submittedRef.current = false;
  }, [error]);

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);

  const setInputRef = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element;
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }
    if (!element) return;

    submittedRef.current = false;
    // A frame later: the click that opened this row is still settling its own
    // focus, and focusing inside it would be undone.
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (inputRef.current !== element) return;
      element.focus();
      if (initialValue) {
        const [start, end] = selectBaseNameRange(initialValue);
        element.setSelectionRange(start, end);
      }
    });
  }, [initialValue]);

  const commit = useCallback((value: string) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(value);
  }, [onSubmit]);

  return (
    <div
      className="flex flex-col"
      data-testid="workspace-inline-input-row"
      data-inline-input-kind={input.kind}
    >
      <div
        className="flex min-w-0 items-center gap-1.5 border-l-2 border-l-(--accent) bg-(--accent)/10 py-1 pr-2"
        style={{ paddingLeft: indent }}
      >
        <span className="h-3.5 w-3.5 shrink-0" />
        <InlineInputIcon kind={input.kind} />
        <input
          {...telemetryClickAttributes('files.inline_input', 'files_panel')}
          ref={setInputRef}
          defaultValue={initialValue}
          placeholder={input.kind === "new-folder" ? "drafts" : "todo.md"}
          autoComplete="off"
          spellCheck={false}
          aria-label={input.kind === "rename"
            ? `New name for ${input.path}`
            : input.kind === "new-folder"
              ? "New folder name"
              : "New file name"}
          aria-invalid={error ? true : undefined}
          className="min-w-0 flex-1 rounded-sm border border-(--accent) bg-(--chat-bg) px-1 py-0.5 font-mono text-[11px] text-(--text-primary) outline-none"
          data-testid="workspace-inline-input"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              submittedRef.current = true;
              onCancel();
            }
          }}
          onBlur={(event) => commit(event.currentTarget.value)}
        />
        {submitting ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-(--text-muted)" />
        ) : null}
      </div>
      {error ? (
        <p
          className="py-0.5 pr-2 text-[11px] text-(--status-error-text)"
          style={{ paddingLeft: indent + 20 }}
          data-testid="workspace-inline-input-error"
          role="alert"
        >
          {error}
        </p>
      ) : hint ? (
        <p
          className="py-0.5 pr-2 text-[11px] text-(--text-muted)"
          style={{ paddingLeft: indent + 20 }}
          data-testid="workspace-inline-input-hint"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
