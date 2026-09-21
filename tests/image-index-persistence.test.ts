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
  const { readImageCache, readImageCards, saveImageCache } = await import('@/lib/db/image-generation-cache');
  const { IMAGE_REFERENCE_REPLAY_VERSION } = await import('@/lib/image-generation/replay-worker');
  const { syncTerminalImageIndex } = await import('@/lib/image-generation/terminal-image-index');
  const { readTraceImageStream } = await import('@/lib/image-generation/session-traces');
  const readText = async (locator: Parameters<typeof readTraceImageStream>[0]) => {
    const image = await readTraceImageStream(locator, '');
    return image ? new Response(image.stream).text() : undefined;
  };
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
      + record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }, { type: 'input_image', image_url: `data:image/png;base64,${inline}` }, { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('second-input-image').toString('base64')}` }] })
      + record('response_item', { type: 'custom_tool_call', call_id: 'call', name: 'functions.exec',
        input: 'const result = await tools.image_gen__imagegen({prompt: "edit", num_last_images_to_include: 2}); generatedImage(result);' }));
    const cancelled = new AbortController(); cancelled.abort();
    const owner = syncTerminalImageIndex(session, '', cancelled.signal);
    const shared = syncTerminalImageIndex(session, '');
    assert.equal((await owner).more, true);
    assert.equal((await shared).more, true, 'a shared cancelled read must not report a committed checkpoint');
    while ((await syncTerminalImageIndex(session, '')).more) { /* bounded catch-up */ }
    const first = readImageCards(session.id);
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'running');
    assert.equal(first[0].inputs.length, 2);
    assert.equal(await readText(first[0].inputs[0].locator), 'test-image-bytes');
    assert.equal(await readText(first[0].inputs[1].locator), 'second-input-image');
    assert.equal(first[0].inputs[0].locator.kind, 'cache');
    const saved = readImageCache(session.id)!;
    assert.equal(saved.state_json.includes(inline), false);
    const initialOffset = JSON.parse(saved.source_json).offset;
    const sidecarPath = path.join(imageSessionCacheDirectory(session.id), 'replay.jsonl');
    const metadata = await fs.readFile(sidecarPath, 'utf8');
    assert.equal(metadata.includes(inline), false, 'worker sidecar must contain no base64 image bytes');
    assert.ok(metadata.includes('__tesseraCachedImage'));
    assert.equal(Buffer.byteLength(metadata), JSON.parse(saved.state_json).sidecarOffset);
    await fs.appendFile(sidecarPath, 'uncommitted retry suffix');
    await syncTerminalImageIndex(session, '');
    assert.equal(readImageCache(session.id)!.source_json, saved.source_json);
    assert.equal(await fs.readFile(sidecarPath, 'utf8'), metadata, 'retry truncates uncommitted sidecar bytes');
    await fs.unlink(sidecarPath);
    while ((await syncTerminalImageIndex(session, '')).more) { /* missing sidecar rebuilds from original source */ }
    assert.deepEqual(readImageCards(session.id), first);
    assert.equal(await fs.readFile(sidecarPath, 'utf8'), metadata);
    await fs.appendFile(file, record('event_msg', { type: 'item_completed', item: { id: 'result', type: 'imageGeneration',
      savedPath: path.join(directory, 'deleted-original.png'), result: inline, revisedPrompt: 'edit', status: 'completed' } })
      + record('response_item', { type: 'custom_tool_call_output', call_id: 'call', output: [{ type: 'image', image_url: `data:image/png;base64,${inline}` }] }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* restores SQLite state */ }
    assert.ok(JSON.parse(readImageCache(session.id)!.source_json).offset > initialOffset);
    const completed = readImageCards(session.id);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, 'completed');
    assert.deepEqual(completed[0].inputs, first[0].inputs);
    const inputPath = path.join(directory, 'reference.png');
    await fs.writeFile(inputPath, Buffer.from('reference-image-bytes'));
    await fs.appendFile(file, record('response_item', { type: 'custom_tool_call', call_id: 'store-paths', name: 'exec',
      input: `const paths=[${JSON.stringify(inputPath)}];store("refs",paths);` }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* reference-only batch */ }
    const withBindings = readImageCache(session.id)!;
    assert.equal(JSON.parse(withBindings.state_json).index.referenceBindings, undefined, 'manual parser bindings are not used');
    assert.equal(withBindings.state_json.includes('const paths='), false, 'source remains in the transcript, not SQLite');
    await fs.appendFile(file, record('response_item', { type: 'custom_tool_call_output', call_id: 'store-paths', output: 'ok' })
      + record('response_item', { type: 'custom_tool_call', call_id: 'dynamic', name: 'functions.exec',
        input: 'const p=load("refs");await tools.image_gen__imagegen({prompt:"dynamic",referenced_image_paths:p.map(path => path)})' }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* reload persisted bindings */ }
    const dynamic = readImageCards(session.id)[1];
    assert.equal(dynamic.unresolvedInputCount, 0);
    assert.equal(dynamic.inputs.length, 1);
    assert.equal(dynamic.inputs[0].locator.kind, 'cache');
    await fs.unlink(inputPath);
    const generatedPath = path.join(directory, 'generated.png');
    await fs.writeFile(generatedPath, 'test-image-bytes');
    await fs.appendFile(file, record('event_msg', { type: 'item_completed', item: { id: 'dynamic-result', type: 'imageGeneration', savedPath: generatedPath, revisedPrompt: 'dynamic', status: 'completed', result: '' } })
      + record('response_item', { type: 'custom_tool_call_output', call_id: 'dynamic', output: 'Script completed' }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* cached inputs survive replay after the source is gone */ }
    assert.deepEqual(readImageCards(session.id)[1].inputs, dynamic.inputs);
    assert.equal(await readText(dynamic.inputs[0].locator), 'reference-image-bytes');
    await fs.unlink(sidecarPath);
    while ((await syncTerminalImageIndex(session, '')).more) { /* exact cached references survive metadata rebuild */ }
    assert.deepEqual(readImageCards(session.id).find(card => card.id === 'dynamic-0')?.inputs, dynamic.inputs);
    // A runtime upgrade must replay an unchanged sidecar while keeping cached
    // explicit inputs whose original files have already disappeared.
    const beforeUpgrade = readImageCache(session.id)!;
    const oldState = JSON.parse(beforeUpgrade.state_json);
    assert.equal(oldState.replayVersion, IMAGE_REFERENCE_REPLAY_VERSION);
    delete oldState.replayVersion;
    oldState.replayRetryAfter = Date.now() + 60_000;
    const oldCards = JSON.parse(beforeUpgrade.cards_json);
    oldCards[0].inputs = [];
    oldCards[0].inputResolutionError = 'Input references could not be reconstructed from this recording.';
    saveImageCache(session.id, JSON.parse(beforeUpgrade.source_json), oldState, oldCards);
    const workerKey = Symbol.for('tessera.imageReplayWorker');
    const workers = globalThis as unknown as Record<symbol, { run: (...args: unknown[]) => Promise<unknown> }>;
    const realWorker = workers[workerKey];
    let requests = 0;
    try {
      workers[workerKey] = { run: async () => { requests++; throw new Error('Image replay time limit exceeded'); } };
      await syncTerminalImageIndex(session, '');
      const failed = JSON.parse(readImageCache(session.id)!.state_json);
      assert.equal(requests, 1, 'old-version backoff cannot postpone upgrade replay');
      assert.equal(failed.replayVersion, undefined, 'a failed replay cannot mark the new engine version as applied');
      assert.equal(failed.replayOffset, -1);
      await syncTerminalImageIndex(session, '');
      assert.equal(requests, 1, 'failed upgrade attempts still respect retry backoff');
      failed.replayRetryAfter = 0;
      saveImageCache(session.id, JSON.parse(beforeUpgrade.source_json), failed, readImageCards(session.id));
      workers[workerKey] = { run: async (...args) => { requests++; return realWorker.run(...args); } };
      await syncTerminalImageIndex(session, '');
      const upgraded = readImageCache(session.id)!;
      assert.equal(requests, 2);
      assert.equal(JSON.parse(upgraded.state_json).replayVersion, IMAGE_REFERENCE_REPLAY_VERSION);
      assert.equal(upgraded.source_json, beforeUpgrade.source_json, 'upgrade does not need a transcript append');
      assert.deepEqual(readImageCards(session.id)[0].inputs, first[0].inputs);
      assert.equal(readImageCards(session.id)[0].inputResolutionError, undefined);
      assert.deepEqual(readImageCards(session.id).find(card => card.id === 'dynamic-0')?.inputs, dynamic.inputs);
      await syncTerminalImageIndex(session, '');
      assert.equal(requests, 2, 'current-version unchanged recordings reuse the replay checkpoint');
    } finally { workers[workerKey] = realWorker; }
    await fs.unlink(generatedPath);
    const viewedPath = path.join(directory, 'viewed.png');
    await fs.writeFile(viewedPath, 'viewed-image-bytes');
    await fs.appendFile(file, record('response_item', { type: 'custom_tool_call', call_id: 'view', name: 'exec',
      input: `const viewed = await tools.view_image({path:${JSON.stringify(viewedPath)}}); image(viewed.image_url);` })
      + record('event_msg', { type: 'item_completed', item: { id: 'view-event', type: 'ImageView', path: viewedPath, status: 'completed' } })
      + record('response_item', { type: 'custom_tool_call_output', call_id: 'view', output: [{ type: 'image', image_url: `data:image/png;base64,${Buffer.from('viewed-image-bytes').toString('base64')}` }] }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* cache viewed file before deleting it */ }
    await fs.unlink(viewedPath);
    await fs.appendFile(file, record('response_item', { type: 'custom_tool_call', call_id: 'recent-followup', name: 'exec',
      input: 'await tools.image_gen__imagegen({prompt:"use generated and viewed",num_last_images_to_include:2});' }));
    while ((await syncTerminalImageIndex(session, '')).more) { /* new references must use prior cached occurrences */ }
    const followup = readImageCards(session.id).find(card => card.id === 'recent-followup-0')!;
    assert.equal(followup.unresolvedInputCount, 0);
    assert.equal(followup.inputs.length, 2);
    assert.deepEqual(followup.inputs.map(input => input.sourceMessageId), ['hist-tool-dynamic-result', 'hist-tool-view-event']);
    assert.equal(await readText(followup.inputs[0].locator), 'test-image-bytes');
    assert.equal(await readText(followup.inputs[1].locator), 'viewed-image-bytes');
    await fs.unlink(file);
    const stillCached = readImageCards(session.id);
    assert.equal(await readText(stillCached[0].result!.locator), 'test-image-bytes');
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
