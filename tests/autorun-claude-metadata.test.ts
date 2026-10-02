import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { readAnalysisContext } from '../src/lib/automation/autorun-context';
import { fixture } from './helpers/autorun-native-fixture';

async function firstTurn() {
  const f = await fixture('claude-code'), sessionId = f.request.providerConversationId;
  const promptId = '7ab43974-3790-40ac-bf63-6fb3b2eed4fa';
  const records: Record<string, unknown>[] = [
    { type: 'user', uuid: 'human', parentUuid: null, sessionId, promptId, message: { content: 'Read stage-one.txt.' } },
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId },
    { type: 'ai-title', aiTitle: 'Read the fixture', sessionId },
    { type: 'assistant', uuid: 'call', parentUuid: 'human', sessionId, message: { id: 'api-read', content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'stage-one.txt' } },
    ] } },
    { type: 'user', uuid: 'result', parentUuid: 'call', sessionId, promptId, message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: 'STAGE_ONE' },
    ] } },
    { type: 'ai-title', aiTitle: 'Read the fixture', sessionId },
    { type: 'permission-mode', permissionMode: 'default', sessionId },
    { type: 'assistant', uuid: 'final', parentUuid: 'result', sessionId, message: { id: 'api-final', content: [{ type: 'text', text: 'PROOF_OK' }] } },
    { type: 'user', uuid: 'later', parentUuid: 'final', sessionId, promptId: 'later-prompt', message: { content: 'Later instruction.' } },
  ];
  const write = () => fs.writeFile(f.file, records.map(r => JSON.stringify(r) + '\n').join(''));
  await write();
  return { ...f, records, write, close: () => fs.rm(f.dir, { recursive: true }) };
}

test('Claude first completed Read remains usable through interleaved title and permission bookkeeping', async () => {
  const f = await firstTurn();
  try {
    const result = await readAnalysisContext(f.request, f.deps);
    assert.equal(result.kind, 'ok', JSON.stringify(result));
    if (result.kind !== 'ok') return;
    assert.deepEqual(result.snapshot.cutoff, { provider: 'claude-code', promptId: '7ab43974-3790-40ac-bf63-6fb3b2eed4fa',
      humanRecordId: 'human', terminalRecordId: 'final', parentUuid: 'result', apiMessageId: 'api-final', endByte: 1272 });
    assert.equal(result.snapshot.contentHash, '03f5c3fb7f88bca5941a43acb6e1b015c2168bcf4477fa5c2d8edbbcff89fcb3');
    assert.deepEqual(result.snapshot.items.map(i => [i.id, i.role, i.text]), [
      ['human', 'user', 'Read stage-one.txt.'], ['call:call:read', 'tool-call', '{"name":"Read","input":{"file_path":"stage-one.txt"}}'],
      ['result:result:read', 'tool-result', 'STAGE_ONE'], ['final', 'assistant', 'PROOF_OK'],
    ]);
    assert.equal(result.snapshot.source.latestTurnStartByte, 0);
  } finally { await f.close(); }
});

for (const type of ['permission-mode', 'ai-title'] as const) {
  for (const fault of ['foreign', 'missing', 'wrong-type', 'empty', 'uuid', 'parent', 'prompt', 'message', 'extra', 'unknown'] as const) {
    test(`Claude ${type} bookkeeping fails closed for ${fault} metadata`, async () => {
      const f = await firstTurn();
      try {
        const metadata = f.records[type === 'permission-mode' ? 1 : 2];
        const field = type === 'permission-mode' ? 'permissionMode' : 'aiTitle';
        if (fault === 'foreign') metadata.sessionId = 'another-conversation';
        if (fault === 'missing') delete metadata[field];
        if (fault === 'wrong-type') metadata[field] = { text: 'not a string' };
        if (fault === 'empty') metadata[field] = '   ';
        if (fault === 'uuid') metadata.uuid = null;
        if (fault === 'parent') metadata.parentUuid = 'human';
        if (fault === 'prompt') metadata.promptId = '7ab43974-3790-40ac-bf63-6fb3b2eed4fa';
        if (fault === 'message') metadata.message = { content: 'Hidden conversational input.' };
        if (fault === 'extra') metadata.extra = true;
        if (fault === 'unknown') metadata.type = 'unknown-bookkeeping';
        await f.write();
        assert.deepEqual(await readAnalysisContext(f.request, f.deps), fault === 'foreign' || fault === 'unknown'
          ? { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'ambiguous-cutoff' }
          : { kind: 'unavailable', code: 'CONTEXT_INCOMPLETE', reason: 'malformed' });
      } finally { await f.close(); }
    });
  }
}

test('Claude metadata cannot hide genuine leading ambiguity, broken tool lineage or an unknown record', async () => {
  const f = await firstTurn();
  try {
    f.records.splice(1, 0, { ...f.records[0], uuid: 'competing-human' });
    await f.write();
    assert.deepEqual(await readAnalysisContext(f.request, f.deps),
      { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'ambiguous-cutoff' });
    f.records.splice(1, 1);
    f.records[4].parentUuid = 'foreign-tool-call';
    await f.write();
    assert.equal((await readAnalysisContext(f.request, f.deps)).kind, 'unavailable');
    f.records[4].parentUuid = 'call';
    f.records.splice(1, 0, { type: 'file-history-snapshot', messageId: 'human', snapshot: {} });
    await f.write();
    assert.equal((await readAnalysisContext(f.request, f.deps)).kind, 'unavailable');
  } finally { await f.close(); }
});

test('Claude later input closes the captured turn before later metadata and identical final text', async () => {
  const f = await firstTurn();
  try {
    f.records.push({ type: 'ai-title', aiTitle: [], sessionId: 'foreign-conversation' },
      { ...f.records[7], uuid: 'later-final', parentUuid: 'later' });
    await f.write();
    const first = await readAnalysisContext(f.request, f.deps);
    assert.equal(first.kind, 'ok', JSON.stringify(first));
    if (first.kind === 'ok') {
      assert.equal(first.snapshot.cutoff.endByte, 1272);
      assert.equal(first.snapshot.contentHash, '03f5c3fb7f88bca5941a43acb6e1b015c2168bcf4477fa5c2d8edbbcff89fcb3');
      assert.ok(!first.snapshot.items.some(i => i.id.startsWith('later')));
    }
  } finally { await f.close(); }
});

test('Claude metadata bytes remain integrity evidence without becoming conversational context', async () => {
  const f = await firstTurn();
  try {
    const first = await readAnalysisContext(f.request, f.deps);
    f.records[2].aiTitle = 'Scan the fixture';
    await f.write();
    const changed = await readAnalysisContext(f.request, f.deps);
    assert.ok(first.kind === 'ok' && changed.kind === 'ok');
    if (first.kind === 'ok' && changed.kind === 'ok') {
      assert.notEqual(first.snapshot.contentHash, changed.snapshot.contentHash);
      assert.deepEqual(changed.snapshot.items, first.snapshot.items);
    }
  } finally { await f.close(); }
});
