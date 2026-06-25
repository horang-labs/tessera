import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImageToolResult,
  buildToolImageUrl,
  inferImageMime,
  isImagePath,
} from '../src/lib/tool-results/tool-image';
import { codexProtocolParser } from '../src/lib/cli/providers/codex/protocol-parser';
import { claudeCodeProtocolParser } from '../src/lib/cli/providers/claude-code/protocol-parser';

// --- helper ---

test('isImagePath recognizes image extensions (and rejects others)', () => {
  for (const p of ['/tmp/a.png', '/x/y.JPG', 'shot.jpeg', 'a.gif', 'b.webp', 'c.svg', 'd.bmp', 'e.avif']) {
    assert.equal(isImagePath(p), true, p);
  }
  for (const p of ['/tmp/a.txt', '/x/y', 'README.md', '', 42, null, undefined]) {
    assert.equal(isImagePath(p as unknown as string), false, String(p));
  }
});

test('inferImageMime maps extensions', () => {
  assert.equal(inferImageMime('/tmp/a.png'), 'image/png');
  assert.equal(inferImageMime('a.JPG'), 'image/jpeg');
  assert.equal(inferImageMime('a.txt'), undefined);
});

test('buildToolImageUrl / buildImageToolResult encode session + toolUseId', () => {
  assert.equal(
    buildToolImageUrl('sess 1', 'call/2'),
    '/api/sessions/sess%201/tool-image?toolUseId=call%2F2',
  );
  assert.deepEqual(buildImageToolResult('s', 'call_x'), {
    kind: 'file_read',
    contentType: 'image',
    url: '/api/sessions/s/tool-image?toolUseId=call_x',
  });
});

// --- codex view_image (imageView) end-to-end through the parser ---

test('Codex imageView maps to a file_read tool call with an inline image result', () => {
  const sid = 'codex-img-1';
  const parsed = codexProtocolParser.parseStdout(
    sid,
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: { type: 'imageView', id: 'call_img1', path: '/tmp/shot.png', status: 'completed' },
      },
    }),
  );

  const toolCall = parsed
    .map((p) => p.serverMessage)
    .find((m) => m && (m as any).type === 'tool_call' && (m as any).toolUseId === 'call_img1') as any;

  assert.ok(toolCall, 'expected a tool_call server message for the imageView item');
  assert.equal(toolCall.toolName, 'ViewImage');
  assert.equal(toolCall.toolKind, 'file_read');
  assert.deepEqual(toolCall.toolUseResult, {
    kind: 'file_read',
    contentType: 'image',
    url: `/api/sessions/${sid}/tool-image?toolUseId=call_img1`,
  });
});

test('Codex imageView with a non-image path does not fabricate an image result', () => {
  const sid = 'codex-img-2';
  const parsed = codexProtocolParser.parseStdout(
    sid,
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: { type: 'imageView', id: 'call_txt1', path: '/tmp/notes.txt', status: 'completed' },
      },
    }),
  );
  const toolCall = parsed
    .map((p) => p.serverMessage)
    .find((m) => m && (m as any).type === 'tool_call' && (m as any).toolUseId === 'call_txt1') as any;

  assert.ok(toolCall, 'expected a tool_call server message');
  assert.equal(toolCall.toolUseResult, undefined);
});

// --- claude code Read of an image through the live tool_result path ---

function lastToolCall(parsed: ReturnType<typeof claudeCodeProtocolParser.parseStdout>, toolUseId: string) {
  return parsed
    .map((p) => p.serverMessage)
    .find((m) => m && (m as any).type === 'tool_call' && (m as any).toolUseId === toolUseId) as any;
}

test('Claude Code image Read emits an inline image result instead of empty text', () => {
  const sid = 'claude-img-1';
  // Register the pending Read tool call.
  claudeCodeProtocolParser.parseStdout(
    sid,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_img', name: 'Read', input: { file_path: '/tmp/a.png' } }] },
    }),
  );
  // Image reads arrive as image content blocks with no text output.
  const parsed = claudeCodeProtocolParser.parseStdout(
    sid,
    JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_img',
      message: {
        is_error: false,
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      },
    }),
  );

  const toolCall = lastToolCall(parsed, 'toolu_img');
  assert.ok(toolCall, 'expected a tool_call server message for the image Read');
  assert.equal(toolCall.toolKind, 'file_read');
  assert.deepEqual(toolCall.toolUseResult, {
    kind: 'file_read',
    contentType: 'image',
    url: `/api/sessions/${sid}/tool-image?toolUseId=toolu_img`,
  });
});

test('Claude Code text Read is unaffected (no image result)', () => {
  const sid = 'claude-img-2';
  claudeCodeProtocolParser.parseStdout(
    sid,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_txt', name: 'Read', input: { file_path: '/tmp/a.ts' } }] },
    }),
  );
  const parsed = claudeCodeProtocolParser.parseStdout(
    sid,
    JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_txt',
      message: { is_error: false, content: [{ type: 'text', text: 'const x = 1;' }] },
    }),
  );

  const toolCall = lastToolCall(parsed, 'toolu_txt');
  assert.ok(toolCall, 'expected a tool_call server message');
  assert.notEqual(toolCall.toolUseResult?.contentType, 'image');
});
