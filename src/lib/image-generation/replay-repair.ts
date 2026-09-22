import type { ImageIndexState } from './incremental-state';
import type { ImageGenerationTrace, ResolvedTraceImage } from './traces';
import { applyReplayDiagnostics, UNRESOLVED_INPUT_REFERENCES, type ReplayDiagnostic } from './replay-diagnostics';
import { normalizeImageTraces, traceResultId } from './trace-identity';

export interface ReplayedInvocation {
  callId: string;
  ordinal: number;
  prompt: string;
  referencedImagePaths?: string[];
  numLastImagesToInclude?: number;
  resultId?: string;
  timestamp: string;
  status: 'running' | 'completed' | 'error';
  error?: string;
  inputResolutionError?: string;
  recentImages?: ResolvedTraceImage[];
}

const UNRESOLVED = UNRESOLVED_INPUT_REFERENCES;

/** Reconcile only exact replay evidence; identical prompts are not an identity. */
export function repairReplayedInputs(index: ImageIndexState, invocations: ReplayedInvocation[], diagnostics: ReplayDiagnostic[] = []): ImageGenerationTrace[] {
  const original = normalizeImageTraces(index.traces);
  const consumed = new Set<ImageGenerationTrace>();
  const repaired: ImageGenerationTrace[] = [];
  const needsCaching: ImageGenerationTrace[] = [];
  const groups = new Map<string, ReplayedInvocation[]>();
  for (const invocation of invocations) {
    const group = groups.get(invocation.callId) ?? [];
    group.push(invocation);
    groups.set(invocation.callId, group);
  }
  for (const invocation of invocations) {
    const id = `${invocation.callId}-${invocation.ordinal}`;
    const resultTrace = invocation.resultId ? original.find((trace) =>
      trace.resultMessageId === invocation.resultId || trace.id === `result-hist-tool-${invocation.resultId}`) : undefined;
    const pendingTrace = original.find((trace) => trace.id === id && !consumed.has(trace)
      && (!trace.resultMessageId || trace.resultMessageId === invocation.resultId));
    const previous = resultTrace ?? pendingTrace;
    const cacheScore = (candidate: ImageGenerationTrace): number => {
      if (invocation.referencedImagePaths) {
        if (JSON.stringify(candidate.referencedImagePaths) !== JSON.stringify(invocation.referencedImagePaths)) return 0;
        return candidate.inputs.filter(image => image.locator.kind === 'cache' && image.locator.path).length;
      }
      if (candidate.numLastImagesToInclude !== invocation.numLastImagesToInclude) return 0;
      const recent = invocation.numLastImagesToInclude ? invocation.recentImages?.slice(-invocation.numLastImagesToInclude) : [];
      return candidate.inputs.filter((image, position) => {
        const occurrence = recent?.[position];
        return occurrence && image.locator.kind === 'cache' && image.locator.path
          && image.sourceMessageId && image.sourceMessageId === occurrence.sourceMessageId
          && image.source === occurrence.source && image.label === occurrence.label;
      }).length;
    };
    const inputPrevious = [pendingTrace, resultTrace].filter((candidate): candidate is ImageGenerationTrace => Boolean(candidate))
      .sort((a, b) => cacheScore(b) - cacheScore(a))[0] ?? previous;
    if (previous) consumed.add(previous);
    if (pendingTrace) consumed.add(pendingTrace);
    const trace: ImageGenerationTrace = {
      ...previous,
      id,
      invocationMessageId: `hist-tool-${invocation.callId}`,
      prompt: previous?.prompt ?? invocation.prompt,
      inputs: previous?.inputs ?? [],
      unresolvedInputCount: previous?.unresolvedInputCount ?? 0,
      timestamp: invocation.timestamp,
      status: invocation.status,
      error: invocation.error,
      ...(invocation.resultId ? { resultMessageId: invocation.resultId } : {}),
    };
    if (invocation.inputResolutionError) {
      trace.inputResolutionError = invocation.inputResolutionError;
      trace.unresolvedInputCount = 0;
    } else {
      trace.prompt = invocation.prompt;
      trace.referencedImagePaths = invocation.referencedImagePaths;
      trace.numLastImagesToInclude = invocation.numLastImagesToInclude;
      delete trace.inputResolutionError;
      trace.unresolvedInputCount = 0;
      if (invocation.referencedImagePaths) {
        const sameReferences = inputPrevious?.referencedImagePaths
          && JSON.stringify(inputPrevious.referencedImagePaths) === JSON.stringify(invocation.referencedImagePaths);
        if (sameReferences && inputPrevious.inputs.length === invocation.referencedImagePaths.length
          && inputPrevious.unresolvedInputCount === 0
          && inputPrevious.inputs.every((image) => image.locator.kind === 'cache' && Boolean(image.locator.path))) {
          // Cached files outlive the original runtime's temporary input paths.
          trace.inputs = inputPrevious.inputs;
          trace.unresolvedInputCount = inputPrevious.unresolvedInputCount;
        } else {
          trace.inputs = invocation.referencedImagePaths.map((path) => (sameReferences
            ? inputPrevious.inputs.find(image => image.locator.kind === 'cache' && image.locator.path
              && (image.agentPath === path || image.label === path)) : undefined) ?? ({
            source: 'explicit-path', label: path, agentPath: path, locator: { kind: 'path', path },
          }));
          if (trace.inputs.length) needsCaching.push(trace);
        }
      } else {
        const count = invocation.numLastImagesToInclude ?? 0;
        if (Number.isInteger(count) && count >= 0 && count <= 5
          && (count === 0 || (invocation.recentImages?.length ?? 0) >= count)) {
          const recent = count ? invocation.recentImages!.slice(-count) : [];
          trace.inputs = recent.map((image, position) => {
            const cached = inputPrevious?.numLastImagesToInclude === count ? inputPrevious.inputs[position] : undefined;
            // Occurrence identity survives replacing a runtime locator with its cached file.
            const sameOccurrence = cached?.locator.kind === 'cache' && Boolean(cached.locator.path)
              && Boolean(image.sourceMessageId) && cached.sourceMessageId === image.sourceMessageId
              && cached.source === image.source && cached.label === image.label;
            return sameOccurrence ? cached : { ...image };
          });
          if (trace.inputs.some((image) => image.locator.kind !== 'cache')) needsCaching.push(trace);
        } else {
          trace.inputs = [];
          trace.inputResolutionError = Number.isInteger(count) && count >= 0 && count <= 5
            ? `Input references unavailable: requested ${count} recent images, but only ${invocation.recentImages?.length ?? 0} recorded image occurrences are available.`
            : 'Input references unavailable: the recorded recent-image count is invalid.';
        }
      }
    }
    repaired.push(trace);
  }
  const completeCalls = [...groups].filter(([, group]) => group.every((call) => call.resultId && call.status !== 'running')).map(([id]) => id);
  const belongsToCompleteCall = (trace: ImageGenerationTrace) => completeCalls.some((callId) =>
    trace.invocationMessageId === `hist-tool-${callId}` || (trace.id.startsWith(`${callId}-`) && /^\d+$/.test(trace.id.slice(callId.length + 1))));
  const repairedIds = new Set(repaired.map((trace) => trace.id));
  const repairedResults = new Set(repaired.map(traceResultId).filter(Boolean));
  index.traces = original.filter((trace) => !consumed.has(trace)
    && !(traceResultId(trace) ? repairedResults.has(traceResultId(trace)) : repairedIds.has(trace.id))
    && (!belongsToCompleteCall(trace) || Boolean(trace.resultMessageId))).map((trace) =>
    repairedIds.has(trace.id) && trace.resultMessageId
      ? { ...trace, id: `result-hist-tool-${trace.resultMessageId}` } : trace);
  for (const trace of index.traces) {
    if (trace.id.startsWith('result-') && trace.unresolvedInputCount > 0 && !trace.referencedImagePaths) {
      trace.inputResolutionError = UNRESOLVED;
      trace.unresolvedInputCount = 0;
    }
  }
  index.traces = normalizeImageTraces([...index.traces, ...repaired]);
  applyReplayDiagnostics(index, diagnostics);
  index.traces.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const running = new Set(index.traces.filter((trace) => trace.status === 'running').map((trace) => trace.id));
  index.pending = [...new Set([...index.pending, ...repaired.filter((trace) => trace.status === 'running').map((trace) => trace.id)])].filter((id) => running.has(id));
  return needsCaching.filter(trace => index.traces.includes(trace));
}
