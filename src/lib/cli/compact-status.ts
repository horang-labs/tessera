/**
 * Compaction status frames from the Claude Code CLI.
 *
 * The CLI reports long-running internal phases as
 * `{"type":"system","subtype":"status","status":"<phase>"}`. Compaction is the
 * only phase the UI currently cares about: `status: "compacting"` opens it and
 * the matching `status: null` closes it, carrying `compact_result` and (on
 * failure) `compact_error`. A `compact_boundary` frame follows a successful run.
 *
 * Nothing on the wire reports how far along a compaction is — the CLI's own TUI
 * bar is a pure function of elapsed time (see `computeCompactProgressPercent`),
 * so this open/close pair is all the docked compacting bar needs.
 */

export const COMPACT_STATUS_SUBTYPE = 'status';
export const COMPACTING_STATUS = 'compacting';

export interface CompactStatusMetadata {
  /** Phase name while active, `null` on the closing frame. */
  status: string | null;
  compactResult?: string;
  compactError?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Returns null for any system frame that is not a status frame. */
export function parseCompactStatusMetadata(raw: any): CompactStatusMetadata | null {
  if (raw?.subtype !== COMPACT_STATUS_SUBTYPE) return null;

  const compactResult = asString(raw.compact_result) ?? asString(raw.compactResult);
  const compactError = asString(raw.compact_error) ?? asString(raw.compactError);

  return {
    status: asString(raw.status) ?? null,
    ...(compactResult ? { compactResult } : {}),
    ...(compactError ? { compactError } : {}),
  };
}

/**
 * Text to show in the transcript for a status frame. Only failures get one:
 * successful open/close frames stay silent (they drive the docked bar instead),
 * and info-severity system messages are filtered out of the transcript anyway.
 * The "failed" wording also lifts the message to error severity downstream.
 */
export function compactStatusFallbackText(meta: CompactStatusMetadata | null): string | undefined {
  if (!meta?.compactError) return undefined;
  return `Compaction failed: ${meta.compactError}`;
}
