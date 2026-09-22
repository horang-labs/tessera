import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { Recording, ReplaySession, replayCells } = createRequire(import.meta.url)('../runtime/image-reference-replay.cjs');

function fixture() {
  const recording = new Recording(), records = [];
  const append = (type, payload) => { const record = { type, payload }; recording.append(record, records.length); records.push(record); };
  const turn = id => append('turn_context', { turn_id: id });
  const call = (id, input) => append('response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input });
  const output = (id, output) => append('response_item', { type: 'custom_tool_call_output', call_id: id, output });
  const event = (id, prompt, turnId = 'turn', extra = {}) => append('event_msg', { type: 'item_completed', turn_id: turnId,
    item: { id, kind: 'image_gen.generation', revisedPrompt: prompt, status: 'completed', result: 'YQ==', ...extra } });
  const image = (id, prompt, path = `/${id}.png`) => call(id,
    `await tools.image_gen__imagegen({prompt:${JSON.stringify(prompt)},referenced_image_paths:[${JSON.stringify(path)}]});`);
  const yielded = id => output(id, `Script running with cell ID ${id}`);
  const hint = id => `Generated images are saved to /images as /images/${id}.png by default.`;
  turn('turn');
  return { recording, records, append, turn, call, output, event, image, yielded, hint };
}

function lateBatch() {
  const f = fixture();
  f.call('earlier', `await Promise.allSettled([0,1,2,3,4].map(async i=>{
    const r=await tools.image_gen__imagegen({prompt:'earlier-'+i,referenced_image_paths:['/earlier.png']});
    text(r.output_hint); }));`);
  for (let i = 0; i < 4; i++) f.event(`exec-earlier-${i}`, `earlier-${i}`);
  f.yielded('earlier');
  f.event('exec-earlier-4', 'earlier-4');
  f.call('later', `await Promise.allSettled([0,1,2,3,4].map(async i=>{
    const r=await tools.image_gen__imagegen({prompt:'later-'+i,referenced_image_paths:['/reference-'+i+'.png']});
    generatedImage(r); await tools.exec_command({cmd:'copy '+i}); }));`);
  for (const i of [2, 0, 1]) f.event(`exec-later-${i}`, `later-${i}`);
  f.output('later', [{ type: 'text', text: 'Script running with cell ID later' },
    ...[2, 0, 1].map(i => ({ type: 'text', text: f.hint(`exec-later-${i}`) }))]);
  f.event('exec-later-3', 'later-3');
  f.append('event_msg', { type: 'turn_aborted', turn_id: 'turn', reason: 'interrupted' });
  f.event('exec-later-4', 'later-4');
  return f;
}

function assertBatch(result) {
  assert.equal(result.invocations.length, 10);
  for (const invocation of result.invocations) {
    assert.equal(invocation.resultId, `exec-${invocation.callId}-${invocation.ordinal}`);
    assert.equal(invocation.status, 'completed');
    assert.equal(invocation.inputResolutionError, undefined);
    assert.deepEqual(invocation.referencedImagePaths, [invocation.callId === 'earlier' ? '/earlier.png' : `/reference-${invocation.ordinal}.png`]);
  }
}

test('an unfinished completed-image batch does not hide late results of the next interrupted batch', async () => {
  assertBatch(await replayCells(lateBatch().recording));
});

test('the streamed recording, persisted unchanged poll and later append retain every late input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'image-association-'));
  try {
    const f = lateBatch(), file = join(directory, 'recording.jsonl');
    // Force separate streaming windows while both execs remain yielded.
    f.records.splice(-2, 0, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x'.repeat(400_000) } });
    await writeFile(file, f.records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const session = new ReplaySession();
    await session.read(file, (await stat(file)).size);
    const first = await session.run(); assertBatch(first);
    await session.read(file, (await stat(file)).size); assert.equal(await session.run(), first);
    await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
    await session.read(file, (await stat(file)).size); assertBatch(await session.run());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('distinct pending calls match reversed completion order across overlapping execs', async () => {
  const f = fixture(); f.image('a', 'first'); f.yielded('a'); f.image('b', 'second');
  f.event('exec-b', 'second'); f.event('exec-a', 'first'); f.yielded('b');
  const r = await replayCells(f.recording);
  assert.deepEqual(r.invocations.map(i => [i.resultId, i.referencedImagePaths]), [['exec-a', ['/a.png']], ['exec-b', ['/b.png']]]);
});

test('identical pending prompts in the same or different execs remain ambiguous', async () => {
  for (const separate of [false, true]) for (const count of [1, 2]) {
    const f = fixture(); f.call('unfinished', 'await new Promise(()=>{});'); f.yielded('unfinished');
    if (separate) { f.image('a', 'same'); f.yielded('a'); f.image('b', 'same'); }
    else f.call('a', `await Promise.all(['/a.png','/b.png'].map(path=>tools.image_gen__imagegen({prompt:'same',referenced_image_paths:[path]})));`);
    for (let i = 0; i < count; i++) f.event(`exec-same-${i}`, 'same');
    const r = await replayCells(f.recording);
    assert.equal(r.invocations.length, 2);
    assert.ok(r.invocations.every(i => !i.resultId), `separate=${separate}, results=${count}`);
  }
});

test('one pending call with multiple matching results is not resolved by arrival order', async () => {
  const f = fixture(); f.call('unfinished', 'await new Promise(()=>{});'); f.yielded('unfinished');
  f.image('a', 'same'); f.event('exec-a', 'same'); f.event('exec-b', 'same');
  assert.equal((await replayCells(f.recording)).invocations[0].resultId, undefined);
});

test('explicitly matched earlier calls do not compete with pending calls using the same prompt', async () => {
  const f = fixture(); f.image('old', 'same'); f.event('exec-old', 'same'); f.yielded('old');
  f.image('new', 'same'); f.event('exec-new', 'same');
  const r = await replayCells(f.recording);
  assert.deepEqual(r.invocations.map(i => i.resultId), ['exec-old', 'exec-new']);
});

test('a later invocation cannot claim an earlier orphan, including within the same exec', async () => {
  const f = fixture(); f.call('unfinished', 'await new Promise(()=>{});'); f.yielded('unfinished');
  f.call('later', `await tools.image_gen__imagegen({prompt:'first'});await tools.image_gen__imagegen({prompt:'second',referenced_image_paths:['/later.png']});`);
  f.event('exec-too-early', 'second'); f.event('exec-first', 'first');
  f.output('later', f.hint('exec-first'));
  f.image('future', 'second');
  const r = await replayCells(f.recording);
  assert.ok(r.invocations.every(i => i.resultId !== 'exec-too-early'));
});

test('known turn ownership excludes other turns and missing turn ownership stays unknown', async () => {
  for (const unknown of [false, true]) {
    const f = fixture(); if (unknown) f.recording.turnId = undefined;
    f.image('old', 'same'); f.yielded('old'); f.turn('new'); f.image('new', 'same');
    f.event('exec-new', 'same', 'new');
    const r = await replayCells(f.recording);
    assert.equal(r.invocations[0].resultId, undefined);
    assert.equal(r.invocations[1].resultId, unknown ? undefined : 'exec-new');
  }
});

test('a failed late result retains its actual failure and never poisons the independent next turn', async () => {
  const f = fixture(); f.call('unfinished', 'await new Promise(()=>{});'); f.yielded('unfinished');
  f.image('failed', 'failed'); f.event('exec-failed', 'failed', 'turn', { status: 'failed', failure: 'Provider rejected request', result: undefined });
  f.yielded('failed'); f.turn('next'); f.image('next', 'next'); f.event('exec-next', 'next', 'next');
  const r = await replayCells(f.recording);
  assert.equal(r.invocations[0].resultId, 'exec-failed'); assert.equal(r.invocations[0].status, 'error');
  assert.equal(r.invocations[0].error, 'Provider rejected request');
  assert.equal(r.invocations[1].resultId, 'exec-next');
});

test('late association repairs captured inputs without inventing an unrecorded continuation', async () => {
  const f = fixture(); f.call('unfinished', 'await new Promise(()=>{});'); f.yielded('unfinished');
  f.call('a', `const r=await tools.image_gen__imagegen({prompt:'captured',referenced_image_paths:['/reference.png']});store('ref',r.output_hint);`);
  f.event('exec-captured', 'captured'); f.output('a', 'Script completed');
  f.turn('next'); f.call('dependent', `await tools.image_gen__imagegen({prompt:'dependent',referenced_image_paths:[load('ref')]});`);
  const r = await replayCells(f.recording);
  assert.equal(r.invocations[0].resultId, 'exec-captured'); assert.deepEqual(r.invocations[0].referencedImagePaths, ['/reference.png']);
  assert.ok(!r.invocations.some(i => i.prompt === 'dependent'));
});

test('an outer script failure after image completion does not become an image generation failure', async () => {
  const f = fixture(); f.call('unfinished', 'await new Promise(()=>{});'); f.yielded('unfinished');
  f.call('a', `await tools.image_gen__imagegen({prompt:'completed',referenced_image_paths:['/a.png']});throw Error('after image');`);
  f.event('exec-completed', 'completed'); f.output('a', 'Script error:\nError: after image');
  const r = await replayCells(f.recording);
  assert.equal(r.invocations[0].resultId, 'exec-completed');
  assert.equal(r.invocations[0].status, 'completed'); assert.equal(r.invocations[0].error, undefined);
});

test('unknown event turns and merely similar prompts are insufficient association evidence', async () => {
  for (const [turn, prompt] of [[undefined, 'exact'], ['turn', 'exact revised']]) {
    const f = fixture(); f.call('unfinished', 'await new Promise(()=>{});'); f.yielded('unfinished');
    f.image('a', 'exact');
    f.append('event_msg', { type: 'item_completed', turn_id: turn, item: {
      id: 'exec-unknown', kind: 'image_gen.generation', revisedPrompt: prompt, status: 'completed', result: 'YQ==' } });
    assert.equal((await replayCells(f.recording)).invocations[0].resultId, undefined);
  }
});

test('seeded completion permutations never interchange distinct references or resolve prompt collisions', async () => {
  let seed = 73921;
  for (let run = 0; run < 30; run++) {
    const f = fixture();
    const entries = Array.from({ length: 12 }, (_, i) => ({ id: `call-${i}`, prompt: i % 4 === 0 ? 'collision' : `prompt-${i}`, path: `/input-${i}.png` }));
    for (const entry of entries) { f.image(entry.id, entry.prompt, entry.path); f.yielded(entry.id); }
    const order = [...entries];
    for (let i = order.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]];
    }
    for (const entry of order) f.event(`exec-${entry.id}`, entry.prompt);
    const r = await replayCells(f.recording);
    assert.equal(r.invocations.length, entries.length);
    for (const [i, entry] of entries.entries()) {
      assert.equal(r.invocations[i].resultId, entry.prompt === 'collision' ? undefined : `exec-${entry.id}`, `permutation ${run}`);
      assert.deepEqual(r.invocations[i].referencedImagePaths, [entry.path]);
    }
  }
});

test('an unreplayed competing exec cannot make a same-prompt result look uniquely owned', async () => {
  const f = fixture();
  f.call('unknown', `await tools.unrecorded_tool({});await tools.image_gen__imagegen({prompt:'same',referenced_image_paths:['/unrecorded-owner.png']});`);
  f.yielded('unknown'); f.image('known', 'same', '/wrong-owner.png');
  f.event('exec-unknown', 'same'); f.yielded('known');
  const r = await replayCells(f.recording);
  assert.equal(r.invocations.length, 1);
  assert.equal(r.invocations[0].resultId, undefined, 'a hidden competing call is not evidence of uniqueness');
});
