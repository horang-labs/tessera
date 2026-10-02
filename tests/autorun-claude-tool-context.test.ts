import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { readAnalysisContext } from '../src/lib/automation/autorun-context';
import { AUTORUN_BOUNDS } from '../src/lib/automation/autorun-contracts';
import { fixture } from './helpers/autorun-native-fixture';

async function toolTurn() {
  const f = await fixture('claude-code');
  const sessionId = f.request.providerConversationId;
  const promptId = '7ab43974-3790-40ac-bf63-6fb3b2eed4fa';
  const record = (type: string, uuid: string, parentUuid: string | null, content?: unknown) => ({
    type, sessionId, uuid, parentUuid, isSidechain: false,
    ...(type === 'user' ? { promptId } : {}),
    ...(content === undefined ? {} : { message: { ...(type === 'assistant' ? { id: 'api-tools' } : {}), content } }),
  });
  const records = [
    record('user', 'human', null, 'Read stage-one.txt and stage-two.txt.'),
    record('attachment', 'attachment', 'human'),
    record('assistant', 'thinking', 'attachment', [{ type: 'thinking', thinking: 'Inspect the requested files.' }]),
    record('assistant', 'calls', 'thinking', [
      { type: 'tool_use', id: 'read-one', name: 'Read', input: { file_path: 'stage-one.txt' } },
      { type: 'tool_use', id: 'read-two', name: 'Read', input: { file_path: 'stage-two.txt' } },
    ]),
    record('user', 'result-one', 'calls', [{ type: 'tool_result', tool_use_id: 'read-one', content: 'STAGE_ONE' }]),
    record('user', 'result-two', 'result-one', [{ type: 'tool_result', tool_use_id: 'read-two', content: [{ type: 'text', text: 'STAGE_TWO' }] }]),
    record('assistant', 'followup-call', 'result-two', [
      { type: 'text', text: 'Checking the remaining file.' },
      { type: 'tool_use', id: 'read-three', name: 'Read', input: { file_path: 'stage-three.txt' } },
    ]),
    record('user', 'result-three', 'followup-call', [{ type: 'tool_result', tool_use_id: 'read-three', content: 'STAGE_THREE' }]),
    record('assistant', 'final', 'result-three', [{ type: 'text', text: 'PROOF_OK' }]),
    { ...record('system', 'stop-summary', 'final'), subtype: 'stop_hook_summary' },
    { ...record('user', 'later-human', 'stop-summary', 'Later instruction must stay outside this capture.'), promptId: 'later-prompt' },
  ];
  const write = () => fs.writeFile(f.file, records.map(r => JSON.stringify(r) + '\n').join(''));
  await write();
  return { ...f, records, write, close: () => fs.rm(f.dir, { recursive: true }) };
}

test('Claude same-promptId tool results retain exact multi-tool evidence and the completed human cutoff', async () => {
  const f = await toolTurn();
  try {
    const result = await readAnalysisContext(f.request, f.deps);
    assert.equal(result.kind, 'ok', JSON.stringify(result));
    if (result.kind !== 'ok') return;
    assert.deepEqual(result.snapshot.cutoff, { provider: 'claude-code', promptId: '7ab43974-3790-40ac-bf63-6fb3b2eed4fa',
      humanRecordId: 'human', terminalRecordId: 'final', parentUuid: 'result-three', apiMessageId: 'api-tools', endByte: 2351 });
    assert.equal(result.snapshot.source.latestTurnStartByte, 0);
    assert.equal(result.snapshot.contentHash, 'cf23c75bf6e7d2563dbb1c7bb91ddca51e95f724fb9c5d7fc2ef39d053c4badf');
    assert.deepEqual(result.snapshot.items.filter(i => i.role === 'tool-call').map(i => [i.id, i.text]), [
      ['calls:call:read-one', '{"name":"Read","input":{"file_path":"stage-one.txt"}}'],
      ['calls:call:read-two', '{"name":"Read","input":{"file_path":"stage-two.txt"}}'],
      ['followup-call:call:read-three', '{"name":"Read","input":{"file_path":"stage-three.txt"}}'],
    ]);
    assert.deepEqual(result.snapshot.items.filter(i => i.role === 'tool-result').map(i => [i.id, i.text]), [
      ['result-one:result:read-one', 'STAGE_ONE'], ['result-two:result:read-two', 'STAGE_TWO'], ['result-three:result:read-three', 'STAGE_THREE'],
    ]);
    assert.deepEqual(result.snapshot.items.filter(i => i.role === 'user').map(i => i.id), ['human']);
    assert.ok(result.snapshot.items.every(i => i.endByte <= result.snapshot.cutoff.endByte));
    assert.equal(result.snapshot.coverage.latestTurnComplete, true);
  } finally { await f.close(); }
});

for (const conflict of ['different-human-id', 'duplicate-human-id'] as const) {
  test(`Claude tool results cannot conceal a conflicting leading input: ${conflict}`, async () => {
    const f = await toolTurn();
    try {
      f.records.splice(1, 0, { ...f.records[0], uuid: conflict === 'different-human-id' ? 'other-human' : 'human',
        parentUuid: 'human', message: { content: [{ type: 'text', text: 'Another leading instruction.' }] } });
      await f.write();
      assert.deepEqual(await readAnalysisContext(f.request, f.deps),
        { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'ambiguous-cutoff' });
    } finally { await f.close(); }
  });
}

test('Claude cannot assign an earlier same-promptId tool result to a later leading human record', async () => {
  const f = await toolTurn();
  try {
    f.records.unshift({ ...f.records[4], uuid: 'earlier-result' });
    await f.write();
    assert.deepEqual(await readAnalysisContext(f.request, f.deps),
      { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'ambiguous-cutoff' });
  } finally { await f.close(); }
});

for (const fault of ['foreign-parent', 'foreign-session', 'duplicate-result-id', 'sidechain', 'missing-tool-id', 'unknown-tool-id'] as const) {
  test(`Claude same-promptId results still require exact lead lineage and paired tools: ${fault}`, async () => {
    const f = await toolTurn();
    try {
      const result = f.records[4];
      if (fault === 'foreign-parent') result.parentUuid = 'unrelated-assistant';
      if (fault === 'foreign-session') result.sessionId = 'other-conversation';
      if (fault === 'duplicate-result-id') result.uuid = 'calls';
      if (fault === 'sidechain') result.isSidechain = true;
      if (fault === 'missing-tool-id' || fault === 'unknown-tool-id') result.message = {
        content: [{ type: 'tool_result', ...(fault === 'unknown-tool-id' ? { tool_use_id: 'unrequested' } : {}), content: 'STAGE_ONE' }],
      };
      await f.write();
      assert.deepEqual(await readAnalysisContext(f.request, f.deps), fault === 'sidechain'
        ? { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'unsafe-runtime' }
        : fault.endsWith('tool-id') ? { kind: 'unavailable', code: 'CONTEXT_INCOMPLETE', reason: 'unresolved-tools' }
          : { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'ambiguous-cutoff' });
    } finally { await f.close(); }
  });
}

test('Claude same-promptId results do not permit competing finals or malformed native records', async () => {
  const f = await toolTurn();
  try {
    f.records.splice(9, 0, { ...f.records[8], uuid: 'competing-final', parentUuid: 'final' });
    await f.write();
    assert.deepEqual(await readAnalysisContext(f.request, f.deps),
      { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'ambiguous-cutoff' });
    await fs.writeFile(f.file, (await fs.readFile(f.file, 'utf8')).replace('"uuid":"result-one"', '"uuid":'));
    assert.deepEqual(await readAnalysisContext(f.request, f.deps),
      { kind: 'unavailable', code: 'CONTEXT_INCOMPLETE', reason: 'malformed' });
  } finally { await f.close(); }
});

test('Claude tool-result excerpts remain bounded while hashing all bytes through the exact final', async () => {
  const f = await toolTurn();
  try {
    f.records[4].message = { content: [{ type: 'tool_result', tool_use_id: 'read-one', content: 'BEGIN' + 'x'.repeat(20_000) + 'END' }] };
    await f.write();
    const first = await readAnalysisContext(f.request, f.deps);
    assert.equal(first.kind, 'ok', JSON.stringify(first));
    if (first.kind !== 'ok') return;
    const excerpt = first.snapshot.items.find(i => i.id === 'result-one:result:read-one')!;
    assert.equal(excerpt.omission, 'head-tail');
    assert.ok(Buffer.byteLength(excerpt.text) <= AUTORUN_BOUNDS.toolExcerptBytes);
    assert.ok(excerpt.text.startsWith('BEGIN') && excerpt.text.endsWith('END'));
    assert.equal(first.snapshot.coverage.toolTruncation, true);
    await fs.writeFile(f.file, (await fs.readFile(f.file, 'utf8')).replace('x'.repeat(100), 'x'.repeat(50) + 'y' + 'x'.repeat(49)));
    const changed = await readAnalysisContext(f.request, f.deps);
    assert.equal(changed.kind, 'ok');
    if (changed.kind === 'ok') assert.notEqual(changed.snapshot.contentHash, first.snapshot.contentHash);
  } finally { await f.close(); }
});
