import type { ImageIndexState } from './incremental-state';

export interface ReplayDiagnostic {
  callId: string;
  /** Result IDs observed in this call's recorded events, never inferred from prompts. */
  resultIds?: string[];
  unresolved?: string;
  error?: string;
  done?: boolean;
}

export const UNRESOLVED_INPUT_REFERENCES = 'Input references could not be reconstructed from this recording.';
const WORKER_FAILURE = 'Input reference replay could not run: ';

/** Present bounded explanations without echoing arbitrary recorded code or tool output. */
export function replayFailureReason(reason: string): string {
  const value = reason.slice(0, 4096);
  if (/Historical tool catalog/i.test(value)) return 'The tool catalog available to the original call was not recorded.';
  if (/Timer and recorded tool completion ordering/i.test(value)) return 'The recording does not establish the completion order of timers and tool calls.';
  if (/Replay state unavailable/i.test(value)) return 'State required from an earlier call could not be reconstructed.';
  if (/Execution was terminated/i.test(value)) return 'The recorded execution was terminated before replay could finish.';
  if (/SyntaxError/.test(value)) return 'The recorded JavaScript call contains a syntax error.';
  if (/ReferenceError/.test(value)) {
    const name = value.match(/['"]?([A-Za-z_$][\w$]{0,63})['"]? is not defined/)?.[1];
    return name ? `The recorded call uses an unavailable function or variable: ${name}.`
      : 'A function or variable used by the recorded call is unavailable during replay.';
  }
  if (/Concurrent execution state ordering/.test(value)) return 'Overlapping executions read stored values whose historical order cannot be reconstructed.';
  if (/image body/i.test(value)) return 'The recorded call requires image contents that metadata-only replay does not load.';
  if (/cannot be uniquely|Repeated prompts/.test(value)) return 'Recorded tool results cannot be uniquely matched to their calls.';
  if (/Unrecorded return field|return is absent|return is not recorded/i.test(value)) return 'A tool return value required by this call is missing from the recording.';
  if (/memory|out of memory/i.test(value)) return 'The replay memory limit was reached.';
  if (/time limit|timed out|interrupted/i.test(value)) return 'The replay execution time limit was reached.';
  if (/exceeded.*limit|limit exceeded/i.test(value)) return 'The recording exceeds a replay processing limit.';
  if (/Cannot find module|ENOENT|no such file/i.test(value)) return 'A required replay runtime file is unavailable.';
  if (/worker exited/i.test(value)) return 'The replay worker stopped before finishing.';
  return 'The recorded call could not be replayed with the available metadata.';
}

export function applyReplayDiagnostics(index: ImageIndexState, diagnostics: ReplayDiagnostic[]): void {
  const calls = new Map<string, Set<ReplayDiagnostic>>();
  const results = new Map<string, Set<ReplayDiagnostic>>();
  const add = (map: Map<string, Set<ReplayDiagnostic>>, id: string, item: ReplayDiagnostic) => {
    const entries = map.get(id) ?? new Set<ReplayDiagnostic>();
    entries.add(item);
    map.set(id, entries);
  };
  for (const diagnostic of diagnostics) {
    add(calls, `hist-tool-${diagnostic.callId}`, diagnostic);
    for (const id of diagnostic.resultIds ?? []) add(results, id, diagnostic);
  }
  for (const trace of index.traces) {
    // Fully reconstructed inputs remain valid even when later code in the cell failed.
    if (!trace.inputResolutionError) continue;
    // A successful retry supersedes diagnostics from the previous replay attempt.
    if (trace.inputResolutionError.startsWith(WORKER_FAILURE)
      || trace.inputResolutionError.startsWith('Input reference replay failed: ')) {
      trace.inputResolutionError = UNRESOLVED_INPUT_REFERENCES;
    }
    // An input-specific finding (for example too few recent images) is more
    // precise than an error elsewhere in the same JavaScript cell.
    if (trace.inputResolutionError !== UNRESOLVED_INPUT_REFERENCES) continue;
    const resultId = trace.resultMessageId ?? (trace.id.startsWith('result-hist-tool-')
      ? trace.id.slice('result-hist-tool-'.length) : undefined);
    const candidates = new Set([
      ...(calls.get(trace.invocationMessageId) ?? []),
      ...(resultId ? results.get(resultId) ?? [] : []),
    ]);
    if (candidates.size !== 1) continue;
    const diagnostic = [...candidates][0];
    const reason = diagnostic.unresolved || diagnostic.error;
    if (reason) trace.inputResolutionError = `Input reference replay failed: ${replayFailureReason(reason)}`;
  }
}

/** This is a session replay failure, not evidence about any individual recorded call. */
export function applyReplayWorkerFailure(index: ImageIndexState, error: unknown): void {
  const reason = replayFailureReason(error instanceof Error ? error.message : String(error));
  for (const trace of index.traces) {
    if (trace.inputResolutionError === UNRESOLVED_INPUT_REFERENCES
      || trace.inputResolutionError?.startsWith(WORKER_FAILURE)) {
      trace.inputResolutionError = WORKER_FAILURE + reason;
    }
  }
}
