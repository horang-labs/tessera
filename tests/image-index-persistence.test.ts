import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(process.cwd(), '.image-index-db-test-'));
process.env.TESSERA_DATA_DIR = directory;
process.env.NODE_ENV = 'test';

test('disk-backed index restores a pending call, reads only appends and serves cards with the transcript gone', async () => {
  const { initDatabase, getDb } = await import('@/lib/db/database');
  const { registerProject } = await import('@/lib/db/projects');
  const { createSession, getSession, deleteSession } = await import('@/lib/db/sessions');
  const { bindTerminalProviderSession } = await import('@/lib/db/terminal-provider-sessions');
  const { readImageCache, readImageCards } = await import('@/lib/db/image-generation-cache');
  const { syncTerminalImageIndex } = await import('@/lib/image-generation/terminal-image-index');
  const { readTraceImageBytes } = await import('@/lib/image-generation/session-traces');
  const { imageSessionCacheDirectory } = await import('@/lib/image-generation/cache-files');
  await initDatabase();
  const file = path.join(directory, 'rollout.jsonl');
  const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: '2026-09-05T00:00:00Z', payload }) + '\n';
  const inline = Buffer.from('test-image-bytes').toString('base64');
  try {
    registerProject('image-project', directory, 'Image test', 'codex');
    createSession('image-session', 'image-project', 'Image test', 'codex', {
      providerState: JSON.stringify({ kind: 'terminal', codexSessionId: 'provider-image-session' }),
    });
    bindTerminalProviderSession({ providerId: 'codex', providerSessionId: 'provider-image-session',
      tesseraSessionId: 'image-session', transcriptPath: file });
    const session = getSession('image-session')!;
    await fs.writeFile(file, record('session_meta', { cli_version: '0.147.0' })
      + record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${inline}` }] })
      + record('response_item', { type: 'custom_tool_call', call_id: 'call', name: 'functions.exec',
        input: 'tools.image_gen__imagegen({prompt: "edit", num_last_images_to_include: 1})' }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* bounded catch-up */ }
    const first = readImageCards(session.id);
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'running');
    assert.equal(first[0].inputs.length, 1);
    assert.equal(first[0].inputs[0].locator.kind, 'cache');
    const saved = readImageCache(session.id)!;
    assert.equal(saved.state_json.includes(inline), false);
    const initialOffset = JSON.parse(saved.source_json).offset;
    await syncTerminalImageIndex(session, '');
    assert.equal(readImageCache(session.id)!.source_json, saved.source_json);
    await fs.appendFile(file, record('event_msg', { type: 'item_completed', item: { id: 'result', type: 'imageGeneration',
      savedPath: path.join(directory, 'deleted-original.png'), result: inline } }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* restores SQLite state */ }
    assert.ok(JSON.parse(readImageCache(session.id)!.source_json).offset > initialOffset);
    const completed = readImageCards(session.id);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, 'completed');
    assert.deepEqual(completed[0].inputs, first[0].inputs);
    await fs.unlink(file);
    const stillCached = readImageCards(session.id);
    const bytes = await readTraceImageBytes(stillCached[0].result!.locator, '');
    assert.equal(bytes?.bytes.toString(), 'test-image-bytes');
    deleteSession(session.id);
    assert.equal(readImageCache(session.id), undefined);
    // Directory removal is asynchronous and deliberately scoped to this session.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await fs.stat(imageSessionCacheDirectory(session.id)).catch(() => null))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await fs.stat(imageSessionCacheDirectory(session.id)).catch(() => null), null);
  } finally {
    getDb().close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
