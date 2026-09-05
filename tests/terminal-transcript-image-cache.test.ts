import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-transcript-image-cache-'));

test('inline transcript tool images are replaced by a cached file URL', async () => {
  const {
    extractCachedTerminalTranscriptImagePath,
    materializeTerminalTranscriptImage,
  } = await import('@/lib/session/terminal-transcript-image-cache');
  const event: SessionHistoryEvent = {
    v: 1,
    type: 'tool_call',
    timestamp: '2026-09-04T00:00:00.000Z',
    toolName: 'exec',
    toolParams: {},
    status: 'completed',
    toolUseId: 'call/image',
    toolUseResult: {
      kind: 'file_read',
      contentType: 'image',
      base64: Buffer.from('image bytes').toString('base64'),
      mimeType: 'image/png',
    },
  };

  const materialized = await materializeTerminalTranscriptImage('session id', event);
  assert.deepEqual((materialized as any).toolUseResult, {
    kind: 'file_read',
    contentType: 'image',
    url: '/api/sessions/session%20id/tool-image?toolUseId=call%2Fimage',
  });
  const cachePath = extractCachedTerminalTranscriptImagePath((materialized as any).toolParams);
  assert.ok(cachePath);
  assert.equal((await fs.readFile(cachePath)).toString(), 'image bytes');
  assert.equal(JSON.stringify(materialized).includes('aW1hZ2UgYnl0ZXM='), false);
});

test('content-addressed transcript image writes are reused', async () => {
  const { materializeTerminalTranscriptImage } = await import('@/lib/session/terminal-transcript-image-cache');
  const event: SessionHistoryEvent = {
    v: 1,
    type: 'tool_call',
    timestamp: '2026-09-04T00:00:00.000Z',
    toolName: 'exec',
    toolParams: {},
    status: 'completed',
    toolUseId: 'repeat',
    toolUseResult: {
      kind: 'file_read',
      contentType: 'image',
      base64: Buffer.from('same image').toString('base64'),
      mimeType: 'image/png',
    },
  };

  const first = await materializeTerminalTranscriptImage('one', event);
  const second = await materializeTerminalTranscriptImage('two', event);
  assert.equal(
    (first as any).toolParams._tesseraTranscriptImagePath,
    (second as any).toolParams._tesseraTranscriptImagePath,
  );
});
