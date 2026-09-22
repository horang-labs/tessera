import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { restoreOwnedImages } from '../src/lib/image-generation/owned-images';
import type { ResolvedTraceImage, ImageGenerationTrace } from '../src/lib/image-generation/traces';

const directory = mkdtempSync(path.join(process.cwd(), '.image-rebuild-audit-'));
process.env.TESSERA_DATA_DIR = directory;
process.env.NODE_ENV = 'test';

test('owned-file recovery requires an observed, unambiguous stable occurrence', () => {
  const image = (sourceMessageId: string, file: string, source: ResolvedTraceImage['source'] = 'generated'): ResolvedTraceImage =>
    ({ sourceMessageId, source, label: 'fixture', locator: { kind: 'cache', path: file } });
  const card = (id: string, status: ImageGenerationTrace['status'] = 'completed'): ImageGenerationTrace =>
    ({ id, resultMessageId: id, invocationMessageId: id, prompt: '', timestamp: '', status, inputs: [], unresolvedInputCount: 0 });
  const old = [image('hist-tool-kept', '/kept.png'), image('hist-tool-removed', '/removed.png'),
    image('hist-user-100', '/user.png', 'conversation'), image('hist-tool-conflict', '/a.png'), image('hist-tool-conflict', '/b.png'),
    image('hist-tool-failed', '/failed.png'), image('hist-tool-source', '/source.png', 'file')];
  const index = { ledger: [image('hist-tool-kept', ''), image('hist-user-100', '', 'conversation'),
    image('hist-tool-conflict', ''), image('hist-tool-source', '')],
  traces: [card('kept'), card('conflict'), card('source'), card('failed', 'error')], pending: [], seenResults: [] };
  restoreOwnedImages(index, [], old);
  assert.deepEqual(index.ledger.map(i => i.locator), [{ kind: 'cache', path: '/kept.png' }, ...Array(3).fill({ kind: 'cache', path: '' })]);
  assert.equal(index.traces[0].result?.locator.kind === 'cache' && index.traces[0].result.locator.path, '/kept.png');
  assert.ok(index.traces.slice(1).every(t => !t.result));
  assert.equal(index.traces.length, 4, 'removed result events cannot be resurrected from an old cache');
});

test('metadata rebuild preserves exact owned occurrences after original temporary files disappear', async t => {
  const { initDatabase, getDb } = await import('@/lib/db/database');
  const { registerProject } = await import('@/lib/db/projects');
  const { createSession, getSession, deleteSession } = await import('@/lib/db/sessions');
  const { bindTerminalProviderSession } = await import('@/lib/db/terminal-provider-sessions');
  const { readImageCards } = await import('@/lib/db/image-generation-cache');
  const { syncTerminalImageIndex } = await import('@/lib/image-generation/terminal-image-index');
  const { imageSessionCacheDirectory } = await import('@/lib/image-generation/cache-files');
  const { readTraceImageStream, ensureTraceInputAgentPaths } = await import('@/lib/image-generation/session-traces');
  const { SettingsManager } = await import('@/lib/settings/manager');
  const userId = 'rebuild-audit';
  await SettingsManager.save(userId, { ...await SettingsManager.load(userId), agentEnvironment: 'wsl' });
  await initDatabase(); registerProject('rebuild-project', directory, 'Rebuild audit', 'codex');
  const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: '2026-09-22T00:00:00Z', payload }) + '\n';
  try {
    for (const kind of ['result', 'recent'] as const) await t.test(kind, async () => {
      const id = `rebuild-${kind}`, file = path.join(directory, `${id}.jsonl`), original = path.join(directory, `${id}.png`);
      await fs.writeFile(original, `${kind}-original-bytes`);
      createSession(id, 'rebuild-project', id, 'codex', { providerState: JSON.stringify({ kind: 'terminal', codexSessionId: id }) });
      bindTerminalProviderSession({ providerId: 'codex', providerSessionId: id, tesseraSessionId: id, transcriptPath: file });
      const session = getSession(id)!;
      const sync = async () => { while ((await syncTerminalImageIndex(session, '')).more) { /* bounded catch-up */ } };
      await fs.writeFile(file, (kind === 'recent'
        ? record('event_msg', { type: 'item_completed', item: { id: 'view', type: 'ImageView', path: original } }) : '')
        + record('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call',
          input: `await tools.image_gen__imagegen({prompt:'audit'${kind === 'recent' ? ',num_last_images_to_include:1' : ''}});` })
        + record('event_msg', { type: 'item_completed', item: { id: 'exec-audit', type: 'imageGeneration', revisedPrompt: 'audit', status: 'completed',
          ...(kind === 'result' ? { savedPath: original } : { result: Buffer.from('generated-bytes').toString('base64') }) } })
        + record('response_item', { type: 'custom_tool_call_output', call_id: 'call', output: 'Script completed' }));
      await sync();
      const before = readImageCards(id)[0];
      const owned = kind === 'result' ? before.result! : before.inputs[0];
      assert.equal(owned.locator.kind, 'cache');
      await fs.unlink(original);
      await fs.unlink(path.join(imageSessionCacheDirectory(id), 'replay.jsonl'));
      await sync();
      const after = readImageCards(id)[0];
      const recovered = kind === 'result' ? after.result : after.inputs[0];
      assert.ok(recovered, 'rebuild lost the owned image');
      assert.deepEqual(recovered.locator, owned.locator);
      const stream = await readTraceImageStream(recovered.locator, '');
      assert.ok(stream); assert.equal(await new Response(stream.stream).text(), `${kind}-original-bytes`);
      assert.equal(after.unresolvedInputCount, 0);
      const dragged = { ...after, inputs: [{ ...recovered, agentPath: original }] };
      await ensureTraceInputAgentPaths([dragged], userId);
      assert.equal(dragged.inputs[0].agentPath, recovered.locator.kind === 'cache' ? recovered.locator.path : undefined,
        'dragging a cached image must not insert the deleted original path');
      deleteSession(id);
    });
  } finally { getDb().close(); await fs.rm(directory, { recursive: true, force: true }); }
});
