"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * The shared shell behind "New folder" and "Rename": a single name field, an
 * inline error, and a submit that stays disabled while the request is out.
 * Only the request differs between the two, so only that is passed in.
 */
export function WorkspaceEntryNameDialog({
  confirmLabel,
  description,
  initialValue = "",
  onOpenChange,
  onSubmit,
  open,
  placeholder,
  testIdPrefix,
  title,
}: {
  confirmLabel: string;
  description: string;
  initialValue?: string;
  onOpenChange: (open: boolean) => void;
  /** Resolves when the entry is written; rejects with the message to show. */
  onSubmit: (value: string) => Promise<void>;
  open: boolean;
  placeholder: string;
  testIdPrefix: string;
  title: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError(null);
    setSubmitting(false);
    // Focus lands after the value is set, and selects the name without its
    // extension so retyping does not mean retyping ".md" every time.
    const timer = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const dot = initialValue.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialValue, open]);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="dialog-title" data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader onClose={() => onOpenChange(false)}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block text-xs text-(--text-muted)" htmlFor={`${testIdPrefix}-input`}>
            {description}
          </label>
          <input
            ref={inputRef}
            id={`${testIdPrefix}-input`}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className="mt-2 h-9 w-full rounded-md border border-(--input-border) bg-(--chat-bg) px-3 font-mono text-sm text-(--text-primary) outline-none focus:border-(--accent)"
            data-testid={`${testIdPrefix}-input`}
          />
          {error ? (
            <p
              className="mt-2 text-xs text-(--status-error-text)"
              data-testid={`${testIdPrefix}-error`}
            >
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
              disabled={!value.trim() || submitting}
              data-testid={`${testIdPrefix}-submit`}
            >
              {submitting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
              <span>{confirmLabel}</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
