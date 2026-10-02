import assert from 'node:assert/strict';
import test from 'node:test';
import { originFixture } from './helpers/autorun-origin-fixture';

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider}: exhausted Heartbeat stays context while equal-text raw/semantic human turns remain goals`, async () => {
    const f = await originFixture(provider);
    try {
      await f.native('human-1', 'Identical instructions'); f.complete();
      assert.equal((await f.wake()).kind, 'delivered');
      assert.equal(f.runtime.ownership('owner', 'session').mode, 'human');
      await f.native('automatic', 'Identical instructions'); f.complete();
      const afterAuto = await f.evidence();
      assert.ok(afterAuto.kind === 'ok' && afterAuto.goal.kind === 'verified');
      if (afterAuto.kind === 'ok' && afterAuto.goal.kind === 'verified') assert.equal(afterAuto.goal.objective.sources.length, 1);
      await f.manager.submitSessionPrompt('session', 'owner', 'Identical instructions');
      await f.native('human-2', 'Identical instructions');
      const result = await f.evidence();
      assert.ok(result.kind === 'ok' && result.goal.kind === 'verified');
      if (result.kind === 'ok' && result.goal.kind === 'verified') {
        assert.equal(result.goal.objective.sources.length, 2);
        assert.ok(result.goal.objective.sources.every(s => !s.recordId.includes('automatic')));
      }
    } finally { await f.close(); }
  });
}

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider}: reordered automation receipt and replay do not absorb a later human correction`, async () => {
    const f = await originFixture(provider);
    try {
      f.manager.write('terminal', 'owner', 'panel', 'normal', 'Original goal\r');
      await f.native('original', 'Original goal'); f.complete();
      assert.equal((await f.wake()).kind, 'delivered');
      const delayedAutomatic = await f.native('automatic', 'Identical instructions', false);
      // The native history is ahead of HTTP delivery. A later accepted semantic correction arrives first.
      f.complete();
      await f.manager.submitSessionPrompt('session', 'owner', 'Correct the goal');
      const delayedHuman = await f.native('correction', 'Correct the goal', false);
      await delayedHuman(); await delayedAutomatic(); await delayedAutomatic(); await delayedHuman();
      const result = await f.evidence();
      assert.ok(result.kind === 'ok' && result.goal.kind === 'verified');
      if (result.kind === 'ok' && result.goal.kind === 'verified') {
        assert.equal(result.goal.objective.text, 'Original goal\n\nCorrect the goal');
        const unchanged = await f.evidence(result.goal.objective.sources.map(s => s.recordId));
        assert.ok(unchanged.kind === 'ok' && unchanged.goal.kind === 'verified');
        if (unchanged.kind === 'ok') assert.deepEqual(unchanged.newHumanInstructions, []);
      }
    } finally { await f.close(); }
  });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evidenceHash } from '../src/lib/automation/autorun-context';
import { readHumanSubmissions, recordHumanSubmission } from '../src/lib/automation/autorun-human-evidence';

test('automation native claim and historical human receipts survive a fresh host process', async () => {
  const f = await originFixture();
  try {
    await f.native('human', 'Original goal'); f.complete(); await f.wake();
    await f.native('automatic', 'Identical instructions');
    const receipts = await readHumanSubmissions('owner', 'session');
    const automatic = receipts!.find(r => r.nativeId === 'automatic')!;
    assert.equal(automatic.origin, 'automation');
    const script = `import originModule from './src/lib/automation/autorun-origin.ts'; import human from './src/lib/automation/autorun-human-evidence.ts'; const {submissionOrigin}=originModule; const {readHumanSubmissions}=human;
      const origin=await submissionOrigin(JSON.parse(process.argv[1])); const receipts=await readHumanSubmissions('owner','session'); console.log(JSON.stringify({origin,human:receipts.filter(r=>r.origin==='human').map(r=>r.nativeId)}));`;
    const args = { event: { kind: 'submission', userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl', terminalId: 'new-terminal', observedAt: Date.now(), evidence: {
      provider: 'codex', providerConversationId: 'conversation', nativeTurnId: 'automatic', observerSubmissionId: automatic.observerSubmissionId, sourceIdentityHash: automatic.sourceIdentityHash, fileGeneration: automatic.fileGeneration, startByte: (await fs.stat(f.file)).size, serverInstanceId: 'new-host', terminalGeneration: 2, dedupKey: 'replay' } }, canonicalPath: f.file, humanOrigin: true };
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(args)], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { origin: 'automation', human: ['human'] });
  } finally { await f.close(); }
});

test('an unclaimed automation write across native generation change cannot invent a human correction', async () => {
  const f = await originFixture();
  try {
    await f.native('human', 'Original goal'); f.complete(); await f.wake();
    const file = path.join(f.dir, '.tessera-autorun', evidenceHash(f.file) + '.generation.json');
    const generation = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...generation, id: 'new-generation' }));
    await f.native('unknown', 'Automated correction');
    const result = await f.evidence();
    assert.ok(result.kind === 'ok' && result.goal.kind === 'missing');
    assert.equal((await readHumanSubmissions('owner', 'session'))!.find(r => r.nativeId === 'unknown')!.origin, 'unknown');
  } finally { await f.close(); }
});

test('legacy arrival-time human labels fail closed instead of replaying the proven QA defect', async () => {
  const f = await originFixture();
  try {
    await f.native('human', 'Original goal');
    const [receipt] = (await readHumanSubmissions('owner', 'session'))!;
    await recordHumanSubmission('owner', 'session', { ...receipt, nativeId: 'legacy', provenance: undefined });
    const result = await f.evidence();
    assert.ok(result.kind === 'ok' && result.goal.kind === 'missing');
  } finally { await f.close(); }
});
