import type { SessionRow } from '@/lib/db/sessions';
import { getSession } from '@/lib/db/sessions';
import fs from 'node:fs/promises';
import { readImageCache, readImageCards, saveImageCache } from '@/lib/db/image-generation-cache';
import { getTerminalProviderSessionForTesseraSession } from '@/lib/db/terminal-provider-sessions';
import { readPersistedTerminalProviderSessionId } from '@/lib/terminal/provider-session-identity';
import { resolveCodexTranscriptPath } from '@/lib/cli/providers/codex/transcript-path';
import { createCodexTranscriptDecoderState, decodeCodexTranscriptLine, type CodexTranscriptDecoderState } from '@/lib/cli/providers/codex/transcript-decoder';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import type { EnhancedMessage } from '@/types/chat';
import logger from '@/lib/logger';
import { appendImage, applyImageTool, createImageIndex, type ImageIndexState } from './incremental-state';
import { cacheImageFile, imageSessionCacheDirectory } from './cache-files';
import { imageFromTool, isImageGenerationResult, resultImage } from './traces';
import { readImageTranscriptBatch, type ImageCheckpoint } from './incremental-reader';

interface SavedState {
  index: ImageIndexState;
  rebuilding?: boolean;
  decoder: { readResponseItemConversation: boolean; pendingToolCalls: Array<[string, CodexTranscriptDecoderState['pendingToolCalls'] extends Map<string, infer V> ? V : never]> };
}

const key = Symbol.for('tessera.imageIndexReads');
const globalReads = globalThis as unknown as Record<symbol, Map<string, Promise<{ more: boolean }>>>;
const reads = globalReads[key] ?? (globalReads[key] = new Map());

export { readImageCards };

export function syncTerminalImageIndex(session: SessionRow, userId: string, signal?: AbortSignal): Promise<{ more: boolean }> {
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
  let decoder = saved ? { ...saved.decoder, pendingToolCalls: new Map(saved.decoder.pendingToolCalls) } : createCodexTranscriptDecoderState();
  const checkpoint: ImageCheckpoint | undefined = cached ? JSON.parse(cached.source_json) : undefined;
  const scanned = await readImageTranscriptBatch(filePath, checkpoint, () => {
    index = createImageIndex(); decoder = createCodexTranscriptDecoderState(); rebuilding = Boolean(cached); reset = true;
  }, async (line, offset) => {
    for (const event of decodeCodexTranscriptLine(line, decoder, { preferInlineImages: true })) {
      if (event.type === 'user_message' && Array.isArray(event.content)) {
        for (const [ordinal, block] of event.content.entries()) {
          if (block.type !== 'image') continue;
          const locator = await cacheImageFile(session.id, { kind: 'inline', data: block.source.data, mimeType: block.source.media_type }, environment).catch(() => undefined);
          appendImage(index, { source: 'conversation', label: `Conversation image ${ordinal + 1}`,
            locator: locator ?? { kind: 'cache', path: '' }, sourceMessageId: `image-${offset}-${ordinal}` });
        }
      }
      if (event.type !== 'tool_call') continue;
      const message = { ...event, id: `hist-tool-${event.toolUseId ?? offset}`, sessionId: session.id } as Extract<EnhancedMessage, { type: 'tool_call' }>;
      const isGeneration = isImageGenerationResult(message);
      const toolImage = message.status !== 'running' ? imageFromTool(message, isGeneration) : undefined;
      const image = isGeneration ? toolImage ?? resultImage(message) : toolImage;
      if (image) {
        let locator;
        try { locator = await cacheImageFile(session.id, image.locator, environment); }
        catch { /* Preserve an unresolved occurrence, never substitute an older image. */ }
        message.toolParams = { ...message.toolParams, _tesseraTranscriptImagePath: locator && locator.kind === 'cache' ? locator.path : '' };
        message.toolUseResult = undefined;
      }
      const previousCardCount = index.traces.length;
      applyImageTool(index, message);
      for (const trace of index.traces.slice(previousCardCount)) {
        for (const input of trace.inputs) {
          if (input.locator.kind !== 'path') continue;
          const locator = await cacheImageFile(session.id, input.locator, environment).catch(() => undefined);
          input.locator = locator ?? { kind: 'cache', path: '' };
          if (!locator) trace.unresolvedInputCount += 1;
        }
        trace.inputs = trace.inputs.filter((input) => input.locator.kind !== 'cache' || Boolean(input.locator.path));
      }
      // Keep only call metadata needed to interpret image-related outputs across batches.
      // Arbitrary shell output, code and base64 are never persisted in this decoder state.
      if (event.toolUseId && event.status === 'running') {
        const params = event.toolParams;
        const relevant = Object.values(params).some((value) => typeof value === 'string' && value.includes('image_gen__imagegen'));
        if (!relevant) decoder.pendingToolCalls.delete(event.toolUseId);
      }
    }
  }, signal);
  const currentSession = getSession(session.id);
  if (!currentSession || currentSession.deleted) {
    await fs.rm(imageSessionCacheDirectory(session.id), { recursive: true, force: true });
    return { more: false };
  }
  if (!signal?.aborted && (scanned.bytesRead > 0 || !cached || reset)) {
    const keepPrevious = rebuilding && scanned.more;
    saveImageCache(session.id, scanned.checkpoint, { index: { ...index, traces: keepPrevious ? index.traces : [] }, rebuilding: keepPrevious,
      decoder: { readResponseItemConversation: decoder.readResponseItemConversation, pendingToolCalls: [...decoder.pendingToolCalls] } },
    keepPrevious && cached ? JSON.parse(cached.cards_json) : index.traces);
  }
  logger.debug({ sessionId: session.id, bytesRead: scanned.bytesRead, offset: scanned.checkpoint.offset,
    cardCount: index.traces.length, more: scanned.more }, 'Image index incremental read');
  return { more: scanned.more };
}
