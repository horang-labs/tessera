import type { ImageIndexState } from './incremental-state';
import type { ImageGenerationTrace, ResolvedTraceImage } from './traces';
import { traceResultId } from './trace-identity';

/** Recover owned files only for occurrences still present in the new recording.
 * Tool IDs survive rewrites; user-image byte offsets are not stable identities.
 */
export function restoreOwnedImages(index: ImageIndexState, cards: ImageGenerationTrace[], ledger: ResolvedTraceImage[]): void {
  const owned = new Map<string, ResolvedTraceImage | null>();
  const key = (image: ResolvedTraceImage) => `${image.source}\0${image.sourceMessageId}`;
  const remember = (image: ResolvedTraceImage) => {
    if (!image.sourceMessageId?.startsWith('hist-tool-') || image.locator.kind !== 'cache' || !image.locator.path) return;
    const id = key(image), previous = owned.get(id);
    if (previous === null) return;
    owned.set(id, previous && previous.locator.kind === 'cache' && previous.locator.path !== image.locator.path ? null : image);
  };
  for (const image of ledger) remember(image);
  for (const card of cards) {
    for (const image of card.inputs) remember(image);
    const id = traceResultId(card);
    if (id && card.result) remember({ ...card.result, sourceMessageId: `hist-tool-${id}` });
  }
  for (const image of index.ledger) {
    const previous = owned.get(key(image));
    if (previous && image.locator.kind === 'cache' && !image.locator.path) image.locator = previous.locator;
  }
  for (const trace of index.traces) {
    const id = traceResultId(trace);
    const previous = id ? owned.get(`generated\0hist-tool-${id}`) : undefined;
    if (trace.status === 'completed' && previous
      && (!trace.result || trace.result.locator.kind === 'cache' && !trace.result.locator.path)) {
      trace.result = { ...previous, ...trace.result, locator: previous.locator };
    }
  }
}
