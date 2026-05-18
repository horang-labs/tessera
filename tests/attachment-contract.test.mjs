import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const attachmentHookSource = fs.readFileSync(
  new URL('../src/hooks/use-message-input-attachments.ts', import.meta.url),
  'utf8',
);
const uploadRouteSource = fs.readFileSync(
  new URL('../src/app/api/upload/route.ts', import.meta.url),
  'utf8',
);
const codexAdapterSource = fs.readFileSync(
  new URL('../src/lib/cli/providers/codex/adapter.ts', import.meta.url),
  'utf8',
);

test('image attachments handle missing browser MIME types by extension', () => {
  assert.match(attachmentHookSource, /IMAGE_EXTENSION_MIME_TYPES/);
  assert.match(attachmentHookSource, /function getSupportedImageMimeType\(file: File \| Blob\)/);
  assert.match(attachmentHookSource, /const imageMimeType = getSupportedImageMimeType\(file\)/);
  assert.match(attachmentHookSource, /handleImageAttachment\(file, imageMimeType\)/);
  assert.match(attachmentHookSource, /mediaType,\n\s+previewUrl/);
});

test('uploaded attachment paths are returned in the agent filesystem style', () => {
  assert.match(uploadRouteSource, /getAgentEnvironment\(auth\.userId\)/);
  assert.match(uploadRouteSource, /normalizeCwdForCliEnvironment\(destPath, agentEnvironment\)/);
  assert.match(uploadRouteSource, /return NextResponse\.json\(\{ path: agentPath, fileName: file\.name \}\)/);
});

test('codex local image attachment paths are normalized for WSL agents', () => {
  assert.match(codexAdapterSource, /agentEnvironment: AgentEnvironment/);
  assert.match(codexAdapterSource, /normalizeCwdForCliEnvironment\(filePath, agentEnvironment\)/);
  assert.match(codexAdapterSource, /persistCodexImage\(attachmentSessionId, b, agentEnvironment\)/);
});
