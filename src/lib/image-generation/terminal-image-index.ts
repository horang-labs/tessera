import type { SessionRow } from '@/lib/db/sessions';
import { getSession } from '@/lib/db/sessions';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readImageCache, readImageCards, saveImageCache } from '@/lib/db/image-generation-cache';
import { getTerminalProviderSessionForTesseraSession } from '@/lib/db/terminal-provider-sessions';
import { readPersistedTerminalProviderSessionId } from '@/lib/terminal/provider-session-identity';
import { resolveCodexTranscriptPath } from '@/lib/cli/providers/codex/transcript-path';
import { createCodexTranscriptDecoderState, decodeCodexTranscriptLine, type CodexTranscriptDecoderState } from '@/lib/cli/providers/codex/transcript-decoder';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import type { EnhancedMessage } from '@/types/chat';
import logger from '@/lib/logger';
import { appendImage, createImageIndex, type ImageIndexState } from './incremental-state';
import { cacheImageFile, imageSessionCacheDirectory } from './cache-files';
import { imageFromTool, isImageGenerationResult, resultImage } from './traces';
import { IMAGE_REFERENCE_REPLAY_ENABLED, replayImageReferences } from './replay-worker';
import { repairReplayedInputs } from './replay-repair';
import { readImageTranscriptBatch, type ImageCheckpoint } from './incremental-reader';

interface SavedState {
  index: ImageIndexState;
  rebuilding?: boolean;
  replayOffset?: number;
  replayRetryAfter?: number;
  sidecarOffset?: number;
  decoder: { readResponseItemConversation: boolean; pendingToolCalls: Array<[string, CodexTranscriptDecoderState['pendingToolCalls'] extends Map<string, infer V> ? V : never]> };
}

const key = Symbol.for('tessera.imageIndexReads');
const globalReads = globalThis as unknown as Record<symbol, Map<string, Promise<{ more: boolean }>>>;
const reads = globalReads[key] ?? (globalReads[key] = new Map());

export { readImageCards };

export function syncTerminalImageIndex(session: SessionRow, userId: string, signal?: AbortSignal): Promise<{ more: boolean }> {
  // Preserve the cached-card path when replay is disabled.
  if (!IMAGE_REFERENCE_REPLAY_ENABLED) return Promise.resolve({ more: false });
  const existing = reads.get(session.id);
  if (existing) return existing;
  const promise = sync(session, userId, signal).finally(async () => {
    try {
      const current = getSession(session.id);
      if (!current || current.deleted) await fs.rm(imageSessionCacheDirectory(session.id), { recursive: true, force: true });
    } finally { reads.delete(session.id); }
  });
  reads.set(session.id, promise);
  return promise;
}

async function sync(session: SessionRow, userId: string, signal?: AbortSignal): Promise<{ more: boolean }> {
  const providerSessionId = readPersistedTerminalProviderSessionId(session);
  if (!providerSessionId) return { more: false };
  const environment = await getAgentEnvironment(userId);
  const filePath = await resolveCodexTranscriptPath({ providerSessionId,
    transcriptPath: getTerminalProviderSessionForTesseraSession(session.id)?.transcript_path, environment });
  if (!filePath) return { more: false };
  const cached = readImageCache(session.id);
  const saved: SavedState | undefined = cached ? JSON.parse(cached.state_json) : undefined;
  let index = saved?.index ?? createImageIndex();
  if (cached && !saved?.rebuilding) index.traces = JSON.parse(cached.cards_json);
  let rebuilding = saved?.rebuilding ?? false;
  let reset = false;
  let replayOffset = saved?.replayOffset ?? -1;
  let replayRetryAfter = saved?.replayRetryAfter ?? 0;
  let decoder = saved ? { ...saved.decoder, pendingToolCalls: new Map(saved.decoder.pendingToolCalls) } : createCodexTranscriptDecoderState();
  const directory = imageSessionCacheDirectory(session.id);
  const sidecarPath = path.join(directory, 'replay.jsonl');
  await fs.mkdir(directory, { recursive: true });
  const sidecarStat = await fs.stat(sidecarPath).catch(() => undefined);
  const sidecarValid = saved?.sidecarOffset !== undefined && sidecarStat && sidecarStat.size >= saved.sidecarOffset;
  let sidecarOffset = sidecarValid ? saved.sidecarOffset! : 0;
  const sidecar = await fs.open(sidecarPath, sidecarStat ? 'r+' : 'w+');
  await sidecar.truncate(sidecarOffset);
  const checkpoint: ImageCheckpoint | undefined = cached && sidecarValid ? JSON.parse(cached.source_json) : undefined;
  try {
  const scanned = await readImageTranscriptBatch(filePath, checkpoint, () => {
    index = createImageIndex(); decoder = createCodexTranscriptDecoderState(); rebuilding = Boolean(cached); reset = true; replayOffset = -1; replayRetryAfter = 0; sidecarOffset = 0;
  }, async (record, offset) => {
    if (sidecarOffset === 0) await sidecar.truncate(0);
    await cacheRecordImages(record, filePath, session.id, environment, signal);
    record.__tesseraRecordOffset = offset;
    const line = JSON.stringify(record);
    const metadata = Buffer.from(line + "\n");
    let written = 0;
    while (written < metadata.length) written += (await sidecar.write(metadata, written, metadata.length - written, sidecarOffset + written)).bytesWritten;
    sidecarOffset += metadata.length;
    const raw = record as Record<string, any>;
    const payload = raw.payload;
    if (raw.type === 'response_item' && payload?.type === 'message'
      && payload.role === 'user' && Array.isArray(payload.content)) {
      for (const [ordinal, block] of payload.content.entries()) {
        if (block?.type !== 'input_image') continue;
        const cachedPath = block.image_url?.__tesseraCachedImage?.path;
        if (!block.image_url?.__tesseraImage) continue;
        appendImage(index, { source: 'conversation', label: `Conversation image ${ordinal + 1}`,
          locator: { kind: 'cache', path: cachedPath ?? '' }, sourceMessageId: `image-${offset}-${ordinal}` });
      }
    }
    // ImageView events carry the occurrence ID needed by num_last references.
    // Their outer exec output can contain several images and has a different ID.
    if (line.includes('"ImageView"')) {
      try {
        const record = JSON.parse(line);
        const item = record.payload?.item;
        if (record.type === 'event_msg' && record.payload?.type === 'item_completed'
          && item?.type === 'ImageView' && typeof item.id === 'string' && typeof item.path === 'string') {
          const locator = await cacheImageFile(session.id, { kind: 'path', path: item.path }, environment).catch(() => undefined);
          appendImage(index, { source: 'file', label: 'Viewed image', sourceMessageId: `hist-tool-${item.id}`,
            locator: locator ?? { kind: 'cache', path: '' } });
        }
      } catch { /* Malformed records are also ignored by the transcript decoder. */ }
    }
    for (const event of decodeCodexTranscriptLine(line, decoder, { preferInlineImages: true, includeImageReferenceScripts: true })) {
      if (event.type !== 'tool_call') continue;
      const message = { ...event, id: `hist-tool-${event.toolUseId ?? offset}`, sessionId: session.id } as Extract<EnhancedMessage, { type: 'tool_call' }>;
      const isGeneration = isImageGenerationResult(message);
      const toolImage = message.status !== 'running' ? imageFromTool(message, isGeneration) : undefined;
      const encodedResult = raw.payload?.item?.result;
      const cachedResult = encodedResult?.__tesseraCachedImage;
      const image = isGeneration && cachedResult?.path
        ? { source: 'generated' as const, label: 'Generated image', locator: { kind: 'cache' as const, path: cachedResult?.path ?? '' } }
        : isGeneration ? toolImage ?? resultImage(message) : toolImage;
      if (image) {
        let locator;
        try { locator = image.locator.kind === 'cache' ? image.locator : await cacheImageFile(session.id, image.locator, environment); }
        catch { /* Preserve an unresolved occurrence, never substitute an older image. */ }
        message.toolParams = { ...message.toolParams, _tesseraTranscriptImagePath: locator && locator.kind === 'cache' ? locator.path : '' };
        message.toolUseResult = undefined;
        appendImage(index, { ...image, locator: locator ?? { kind: 'cache', path: '' }, sourceMessageId: message.id });
      }
      if (isGeneration && !index.seenResults.includes(message.id)) {
        index.seenResults.push(message.id);
        const result = resultImage(message);
        index.traces.push({ id: `result-${message.id}`, invocationMessageId: message.id,
          resultMessageId: event.toolUseId, prompt: typeof message.toolParams.revisedPrompt === 'string'
            ? message.toolParams.revisedPrompt : 'Image generation',
          revisedPrompt: typeof message.toolParams.revisedPrompt === 'string' ? message.toolParams.revisedPrompt : undefined,
          inputs: [], unresolvedInputCount: 0,
          inputResolutionError: 'Input references could not be reconstructed from this recording.',
          status: message.status, result, timestamp: message.timestamp, error: message.error });
      }
      // The replay worker owns exec state. The JSONL decoder only needs result metadata.
      if (event.toolUseId && event.status === 'running') decoder.pendingToolCalls.delete(event.toolUseId);
    }
  }, signal);
  if (sidecarOffset === 0) await sidecar.truncate(0);
  if (!scanned.more && !signal?.aborted && replayOffset !== scanned.checkpoint.offset
    && (scanned.bytesRead > 0 || Date.now() >= replayRetryAfter)) {
    try {
      const replay = await replayImageReferences({ sessionId: session.id, path: sidecarPath,
        offset: sidecarOffset, reset }, signal);
      const cachedImages = new Map(index.ledger.filter(image => image.sourceMessageId)
        .map(image => [image.sourceMessageId, image]));
      for (const invocation of replay.invocations) {
        invocation.recentImages = invocation.recentImages?.map(image => {
          const cachedImage = image.sourceMessageId ? cachedImages.get(image.sourceMessageId) : undefined;
          return cachedImage?.locator.kind === 'cache' && cachedImage.locator.path
            ? { ...image, locator: cachedImage.locator } : image;
        });
      }
      if (rebuilding && cached) {
        // Rebuilding metadata must not discard owned input files. Seed only exact
        // call/reference matches, without carrying any previous result or status.
        const previousCards = new Map((JSON.parse(cached.cards_json) as ImageIndexState['traces']).map(trace => [trace.id, trace]));
        const presentIds = new Set(index.traces.map(trace => trace.id));
        for (const invocation of replay.invocations) {
          const id = `${invocation.callId}-${invocation.ordinal}`;
          if (invocation.inputResolutionError || !invocation.referencedImagePaths || presentIds.has(id)) continue;
          const previous = previousCards.get(id);
          if (!previous || JSON.stringify(previous.referencedImagePaths) !== JSON.stringify(invocation.referencedImagePaths)
            || !previous.inputs.every(image => image.locator.kind === 'cache' && Boolean(image.locator.path))) continue;
          presentIds.add(id);
          index.traces.push({ id, invocationMessageId: `hist-tool-${invocation.callId}`, prompt: invocation.prompt,
            referencedImagePaths: invocation.referencedImagePaths, inputs: previous.inputs,
            unresolvedInputCount: previous.unresolvedInputCount, status: 'running', timestamp: invocation.timestamp });
        }
      }
      const needsCaching = repairReplayedInputs(index, replay.invocations);
      for (const trace of needsCaching) {
        for (const input of trace.inputs) {
          if (signal?.aborted) throw new Error('Image replay aborted');
          if (input.locator.kind === 'cache') continue;
          const locator = await cacheImageFile(session.id, input.locator, environment).catch(() => undefined);
          input.locator = locator ?? { kind: 'cache', path: '' };
          if (!locator) trace.unresolvedInputCount++;
        }
        trace.inputs = trace.inputs.filter(input => input.locator.kind !== 'cache' || Boolean(input.locator.path));
      }
      replayOffset = scanned.checkpoint.offset;
      replayRetryAfter = 0;
      logger.debug({ sessionId: session.id, cells: replay.cells,
        unresolved: replay.diagnostics.filter(item => item.unresolved).length }, 'Image reference replay');
    } catch (error) {
      if (!signal?.aborted) {
        logger.warn({ sessionId: session.id, error }, 'Image reference replay failed');
        // Back off worker failures, while allowing transient failures to recover without a transcript append.
        replayRetryAfter = Date.now() + 30_000;
      }
    }
  }
  const currentSession = getSession(session.id);
  if (!currentSession || currentSession.deleted) {
    await fs.rm(imageSessionCacheDirectory(session.id), { recursive: true, force: true });
    return { more: false };
  }
  if (!signal?.aborted && (scanned.bytesRead > 0 || !cached || reset || replayOffset !== saved?.replayOffset || replayRetryAfter !== saved?.replayRetryAfter)) {
    const keepPrevious = rebuilding && scanned.more;
    saveImageCache(session.id, scanned.checkpoint, { index: { ...index, traces: keepPrevious ? index.traces : [] }, rebuilding: keepPrevious, replayOffset, replayRetryAfter, sidecarOffset,
      decoder: { readResponseItemConversation: decoder.readResponseItemConversation, pendingToolCalls: [...decoder.pendingToolCalls] } },
    keepPrevious && cached ? JSON.parse(cached.cards_json) : index.traces);
  }
  logger.debug({ sessionId: session.id, bytesRead: scanned.bytesRead, offset: scanned.checkpoint.offset,
    cardCount: index.traces.length, more: scanned.more }, 'Image index incremental read');
  // A second request may share this read. Cancellation never means its checkpoint was committed.
  return { more: scanned.more || Boolean(signal?.aborted) };
  } finally { await sidecar.close(); }
}

/** Resolve image byte spans before sending metadata to the replay worker. */
async function cacheRecordImages(record: unknown, transcriptPath: string, sessionId: string,
  environment: Awaited<ReturnType<typeof getAgentEnvironment>>, signal?: AbortSignal): Promise<void> {
  if (!record || typeof record !== 'object') return;
  const value = record as Record<string, any>;
  if (value.__tesseraImage) {
    if (signal?.aborted) throw new Error('Image indexing aborted');
    const marker = value.__tesseraImage;
    if (Number.isSafeInteger(marker.offset) && Number.isSafeInteger(marker.length)) {
      const locator = await cacheImageFile(sessionId, { kind: 'transcript', path: transcriptPath,
        offset: marker.offset, length: marker.length, dataUrl: marker.dataUrl === true }, environment).catch(() => undefined);
      value.__tesseraCachedImage = { path: locator?.kind === 'cache' ? locator.path : '' };
    }
    return;
  }
  for (const child of Object.values(value)) await cacheRecordImages(child, transcriptPath, sessionId, environment, signal);
}
