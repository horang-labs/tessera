import type { ImageIndexState } from './incremental-state';
import type { ImageGenerationTrace, ResolvedTraceImage } from './traces';

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

const UNRESOLVED = 'Input references could not be reconstructed from this recording.';

/** Reconcile only exact replay evidence; identical prompts are not an identity. */
export function repairReplayedInputs(index: ImageIndexState, invocations: ReplayedInvocation[]): ImageGenerationTrace[] {
  const original = [...index.traces];
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
    const inputPrevious = pendingTrace ?? previous;
    if (previous) consumed.add(previous);
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
        if (sameReferences && inputPrevious.inputs.every((image) => image.locator.kind === 'cache')) {
          // Cached files outlive the original runtime's temporary input paths.
          trace.inputs = inputPrevious.inputs;
          trace.unresolvedInputCount = inputPrevious.unresolvedInputCount;
        } else {
          trace.inputs = invocation.referencedImagePaths.map((path) => ({
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
          trace.inputResolutionError = UNRESOLVED;
        }
      }
    }
    repaired.push(trace);
  }
  const completeCalls = [...groups].filter(([, group]) => group.every((call) => call.resultId && call.status !== 'running')).map(([id]) => id);
  const belongsToCompleteCall = (trace: ImageGenerationTrace) => completeCalls.some((callId) =>
    trace.invocationMessageId === `hist-tool-${callId}` || (trace.id.startsWith(`${callId}-`) && /^\d+$/.test(trace.id.slice(callId.length + 1))));
  const repairedIds = new Set(repaired.map((trace) => trace.id));
  index.traces = original.filter((trace) => !consumed.has(trace)
    && (!belongsToCompleteCall(trace) || Boolean(trace.resultMessageId))).map((trace) =>
    repairedIds.has(trace.id) && trace.resultMessageId
      ? { ...trace, id: `result-hist-tool-${trace.resultMessageId}` } : trace);
  for (const trace of index.traces) {
    if (trace.id.startsWith('result-') && trace.unresolvedInputCount > 0 && !trace.referencedImagePaths) {
      trace.inputResolutionError = UNRESOLVED;
      trace.unresolvedInputCount = 0;
    }
  }
  index.traces.push(...repaired);
  index.traces.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const running = new Set(index.traces.filter((trace) => trace.status === 'running').map((trace) => trace.id));
  index.pending = [...new Set([...index.pending, ...repaired.filter((trace) => trace.status === 'running').map((trace) => trace.id)])].filter((id) => running.has(id));
  return needsCaching;
}
