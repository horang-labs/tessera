import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { ReplaySession } = createRequire(import.meta.url)('../runtime/image-reference-replay.cjs');
const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const call = (id, input) => record('response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input });
const output = (id, value = 'Script completed') => record('response_item', { type: 'custom_tool_call_output', call_id: id, output: value });
const result = (id, prompt, turn) => record('event_msg', { type: 'item_completed', turn_id: turn,
  item: { id, kind: 'image_gen.generation', revisedPrompt: prompt, status: 'completed', result: 'YQ==' } });

async function replay(source) {
  const directory = await mkdtemp(join(tmpdir(), 'image-gap-'));
  try {
    const file = join(directory, 'recording.jsonl'); await writeFile(file, source);
    const session = new ReplaySession(); await session.read(file, (await stat(file)).size); return await session.run();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('record limits and malformed records isolate their failure, stored state and recent-image history', async () => {
  for (const bad of [
    record('event_msg', { blocks: Array(20).fill('x'.repeat(64000)) }),
    '{"payload":' + '['.repeat(80) + '0' + ']'.repeat(80) + '}\n',
    call('oversized', 'x'.repeat(300000)),
    '{"type":"response_item","payload":malformed}\n',
  ]) {
    const r = await replay(
      record('turn_context', { turn_id: 'old' })
      + record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] })
      + call('seed', `store('ref','/old.png');`) + output('seed') + bad
      + record('turn_context', { turn_id: 'new' })
      + call('dependent', `await tools.image_gen__imagegen({prompt:'dependent',referenced_image_paths:[load('ref')||'/invented.png']});`) + output('dependent')
      + call('independent', `await tools.image_gen__imagegen({prompt:'independent',num_last_images_to_include:1});`)
      + result('exec-independent', 'independent', 'new') + output('independent'));
    assert.equal(r.invocations.length, 1);
    assert.equal(r.invocations[0].resultId, 'exec-independent');
    assert.deepEqual(r.invocations[0].recentImages, [], 'an omitted record may have introduced a newer image');
    assert.ok(r.diagnostics.some(d => /Recorded metadata unavailable/.test(d.unresolved ?? '')));
  }
});

test('an omitted call cannot cause guessed same-turn ownership; a returned result ID remains sufficient', async () => {
  for (const hint of [false, true]) {
    const r = await replay(record('turn_context', { turn_id: 'turn' })
      + '{"broken":?}\n'
      + call('known', `await tools.image_gen__imagegen({prompt:'same',referenced_image_paths:['/known.png']});`)
      + result('exec-known', 'same', 'turn')
      + output('known', hint ? 'Generated images are saved to /exec-known.png' : 'Script completed'));
    assert.equal(r.invocations[0].resultId, hint ? 'exec-known' : undefined);
  }
});
