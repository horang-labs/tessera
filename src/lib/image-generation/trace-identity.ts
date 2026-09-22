import type { ImageGenerationTrace } from './traces';

export function traceResultId(trace: ImageGenerationTrace): string | undefined {
  return trace.resultMessageId ?? (trace.id.startsWith('result-hist-tool-')
    ? trace.id.slice('result-hist-tool-'.length) : undefined);
}

function quality(trace: ImageGenerationTrace): number {
  return (trace.result ? 10_000 : 0)
    + (trace.inputResolutionError ? 0 : Math.min(trace.inputs.length, 64) * 10)
    + (trace.id.startsWith('result-') ? 0 : 4)
    + (trace.status === 'completed' ? 2 : trace.status === 'running' ? 1 : 0);
}

/** Normalize metadata only. Never merge references between different results. */
export function normalizeImageTraces(traces: ImageGenerationTrace[]): ImageGenerationTrace[] {
  const results = new Map<string, ImageGenerationTrace>();
  for (const trace of traces) {
    const resultId = traceResultId(trace);
    if (!resultId) continue;
    const previous = results.get(resultId);
    if (!previous || quality(trace) > quality(previous)) results.set(resultId, trace);
  }
  const groups = new Map<string, ImageGenerationTrace[]>();
  for (const trace of traces) {
    const resultId = traceResultId(trace);
    if (resultId && results.get(resultId) !== trace) continue;
    const group = groups.get(trace.id) ?? [];
    if (!group.includes(trace)) group.push(trace);
    groups.set(trace.id, group);
  }
  const normalized = new Map<string, ImageGenerationTrace>();
  const add = (trace: ImageGenerationTrace) => {
    const previous = normalized.get(trace.id);
    if (!previous || quality(trace) > quality(previous)) normalized.set(trace.id, trace);
  };
  for (const group of groups.values()) {
    const identified = group.filter(trace => traceResultId(trace));
    if (identified.length > 1) {
      // Conflicting result identities cannot share an invocation URL. Keep all
      // real results, each under its own identity, without guessing an owner.
      for (const trace of identified) add({ ...trace, id: `result-hist-tool-${traceResultId(trace)}` });
    } else add(group.reduce((best, trace) => quality(trace) > quality(best) ? trace : best));
  }
  return [...normalized.values()];
}
