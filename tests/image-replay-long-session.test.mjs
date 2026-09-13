import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { ReplaySession } = createRequire(import.meta.url)('../runtime/image-reference-replay.cjs');

test('long metadata histories release completed cells while preserving JS state and append replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-long-'));
  const path = join(directory, 'metadata.jsonl');
  const file = await open(path, 'w');
  const record = payload => file.write(JSON.stringify({ type: 'response_item', payload }) + '\n');
  const call = (id, input) => record({ type: 'custom_tool_call', name: 'exec', call_id: id, input });
  const output = (id, output = []) => record({ type: 'custom_tool_call_output', call_id: id, output });
  try {
    await call('seed', 'store("path",new Map([["ref","/reference.png"]]));');
    await output('seed');
    await call('generated', 'store("generated",await tools.image_gen__imagegen({prompt:"seed image"}));');
    await output('generated', 'Script running with cell ID waiting');
    // A wait can span multiple scanner windows without closing the original cell.
    for (let i = 0; i < 4; i++) await record({ type: 'message', role: 'assistant', content: 'y'.repeat(100_000) });
    await record({ type: 'function_call', name: 'functions.wait', call_id: 'wait', arguments: '{"cell_id":"waiting"}' });
    await file.write(JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: {
      id: 'exec-seed', kind: 'image_gen.generation', status: 'completed', revisedPrompt: 'seed image', result: 'YQ=='
    } } }) + '\n');
    await output('wait', [{ type: 'text', text: JSON.stringify({ output_hint: 'Generated images are saved to /exec-seed.png' }) }]);
    for (let i = 0; i < 200; i++) {
      await call(`padding-${i}`, 'text("recorded output");');
      await output(`padding-${i}`, 'x'.repeat(100_000));
    }
    await call('image', 'await tools.image_gen__imagegen({prompt:"long session",referenced_image_paths:[load("path").get("ref"),load("generated").output_hint.replace("Generated images are saved to ","")]});');
    const session = new ReplaySession();
    await session.read(path, (await stat(path)).size);
    const first = await session.run();
    assert.deepEqual(first.invocations[1]?.referencedImagePaths, ['/reference.png', '/exec-seed.png']);
    assert.equal(first.invocations[0].resultId, 'exec-seed');
    await session.read(path, (await stat(path)).size);
    assert.equal(await session.run(), first, 'unchanged polls reuse the completed result');
    await output('image');
    await call('appended', 'await tools.image_gen__imagegen({prompt:"append",referenced_image_paths:["/appended.png"]});');
    await session.read(path, (await stat(path)).size);
    const second = await session.run();
    assert.deepEqual(second.invocations.map(i => i.referencedImagePaths), [undefined, ['/reference.png', '/exec-seed.png'], ['/appended.png']]);
    await writeFile(path, JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'replacement',
      input: 'await tools.image_gen__imagegen({prompt:"replacement",referenced_image_paths:["/replacement.png"]});' } }) + '\n');
    await session.read(path, (await stat(path)).size);
    assert.deepEqual((await session.run()).invocations.map(i => i.referencedImagePaths), [['/replacement.png']]);
  } finally { await file.close(); await rm(directory, { recursive: true, force: true }); }
});
