import type { EnhancedMessage } from '@/types/chat';
import { imageFromTool, isImageGenerationResult, parseImageGenerationInvocations, resultImage,
  type ImageGenerationTrace, type ResolvedTraceImage } from './traces';

export interface ImageIndexState {
  ledger: ResolvedTraceImage[];
  traces: ImageGenerationTrace[];
  pending: string[];
  seenResults: string[];
}

export function createImageIndex(): ImageIndexState {
  return { ledger: [], traces: [], pending: [], seenResults: [] };
}

/** File-backed images only. Preserve occurrences, not just unique file hashes. */
export function appendImage(state: ImageIndexState, image: ResolvedTraceImage): void {
  if (state.ledger.some((entry) => entry.sourceMessageId === image.sourceMessageId)) return;
  state.ledger.push(image);
}

/** Incremental counterpart of projectImageGenerationTraces; no full chat replay. */
export function applyImageTool(state: ImageIndexState, message: Extract<EnhancedMessage, { type: 'tool_call' }>): void {
  if (isImageGenerationResult(message)) {
    if (state.seenResults.includes(message.id)) return;
    state.seenResults.push(message.id);
    // The transcript does not always supply a parent call ID. Do not assign an
    // out-of-order result to an arbitrary pending prompt when association is ambiguous.
    if (state.pending.length > 1) {
      for (const pending of state.traces.filter((entry) => state.pending.includes(entry.id))) {
        pending.status = 'error';
        pending.error = 'Image result could not be matched to this call.';
      }
      state.pending = [];
    }
    const traceId = state.pending.shift();
    const trace = state.traces.find((entry) => entry.id === traceId);
    const image = resultImage(message);
    if (trace) {
      trace.status = message.status;
      trace.revisedPrompt = typeof message.toolParams.revisedPrompt === 'string' ? message.toolParams.revisedPrompt : undefined;
      trace.error = message.error;
      trace.result = image;
    } else {
      state.traces.push({ id: `result-${message.id}`, invocationMessageId: message.id,
        prompt: typeof message.toolParams.revisedPrompt === 'string' ? message.toolParams.revisedPrompt : 'Image generation',
        inputs: [], unresolvedInputCount: 1, status: message.status, result: image,
        timestamp: message.timestamp, error: message.error });
    }
    // Both result representations belong to the same invocation occurrence.
    // Identical pixels from two different calls still count as two images.
    if (image) appendImage(state, { ...image, sourceMessageId: trace?.id ?? message.id });
    return;
  }
  const source = ['input', 'source', 'code', 'command', 'arguments']
    .map((key) => message.toolParams[key])
    .find((value): value is string => typeof value === 'string' && value.includes('image_gen__imagegen'));
  const invocations = source ? parseImageGenerationInvocations(source) : [];
  for (const [index, invocation] of invocations.entries()) {
    const id = `${message.toolUseId ?? message.id}-${index}`;
    // A tool result repeats its call parameters. It must never create another card.
    if (state.traces.some((trace) => trace.id === id)) continue;
    const requested = invocation.numLastImagesToInclude ?? 0;
    let inputs: ResolvedTraceImage[] = invocation.referencedImagePaths
      ? invocation.referencedImagePaths.map((path) => ({ source: 'explicit-path', label: path, locator: { kind: 'path', path } }))
      : requested > 0 && requested <= state.ledger.length ? state.ledger.slice(-requested) : [];
    const missing = invocation.referencesUnresolved || (index > 0 && requested > 0) || (!invocation.referencedImagePaths && (requested > state.ledger.length
      || inputs.some((image) => image.locator.kind === 'cache' && !image.locator.path)));
    if (missing) inputs = [];
    state.traces.push({ id, invocationMessageId: message.id, ...invocation, inputs: inputs.map((image) => ({ ...image })),
      unresolvedInputCount: missing ? Math.max(1, requested) : 0,
      status: 'running', timestamp: message.timestamp });
    state.pending.push(id);
  }
  if (message.status === 'error') {
    for (const trace of state.traces.filter((entry) => entry.invocationMessageId === message.id && entry.status === 'running')) {
      trace.status = 'error';
      trace.error = message.error;
      state.pending = state.pending.filter((id) => id !== trace.id);
    }
  }
  if (message.status !== 'running') {
    const image = imageFromTool(message, Boolean(source));
    if (image && invocations.length <= 1) appendImage(state, {
      ...image, sourceMessageId: invocations.length === 1 ? `${message.toolUseId ?? message.id}-0` : image.sourceMessageId,
    });
  }
}
