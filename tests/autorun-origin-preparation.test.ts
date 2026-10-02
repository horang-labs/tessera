import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { originFixture } from './helpers/autorun-origin-fixture';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider}: Pause while the native read is pending prevents late write and leaves genuine human provenance usable`, async () => {
    const f = await originFixture(provider), originalOpen = fs.open;
    const entered = deferred(), release = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      await f.native('original', 'Original goal'); f.complete();
      fs.open = async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === f.file) { entered.resolve(); await release.promise; }
        return originalOpen(...args);
      };
      ({ pending } = await f.beginWake());
      await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(Error('native read not reached')), 1000))]);
      assert.deepEqual(f.writes, []); assert.deepEqual(f.fences, []);
      assert.equal(f.runtime.drain({ userId: 'owner', sessionId: 'session', automationId: 'rule' }).mode, 'draining');
      release.resolve();
      assert.equal((await pending as { kind: string }).kind, 'cancelled');
      assert.deepEqual(f.writes, []); assert.deepEqual(f.fences, []);
      assert.equal(f.runtime.ownership('owner', 'session').mode, 'human');
      fs.open = originalOpen;
      await f.manager.submitSessionPrompt('session', 'owner', 'Genuine correction');
      await f.native('correction', 'Genuine correction');
      const result = await f.evidence();
      assert.ok(result.kind === 'ok' && result.goal.kind === 'verified');
      if (result.kind === 'ok' && result.goal.kind === 'verified') assert.equal(result.goal.objective.text, 'Original goal\n\nGenuine correction');
    } finally { release.resolve(); if (pending) await pending; fs.open = originalOpen; await f.close(); }
  });

  test(`${provider}: failed native preparation never enters the write fence or leaves a phantom automation turn`, async () => {
    const f = await originFixture(provider), originalOpen = fs.open;
    try {
      await f.native('original', 'Original goal'); f.complete();
      fs.open = async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === f.file) throw Error('Owned simulated disconnected UNC');
        return originalOpen(...args);
      };
      const { pending } = await f.beginWake();
      assert.equal((await pending).kind, 'cancelled');
      assert.deepEqual(f.writes, []); assert.deepEqual(f.fences, []);
      f.runtime.drain({ userId: 'owner', sessionId: 'session', automationId: 'rule' });
      fs.open = originalOpen;
      f.manager.write('terminal', 'owner', 'panel', 'normal', 'Genuine correction\r', f.runtime.ownership('owner', 'session').epoch);
      await f.native('correction', 'Genuine correction');
      const result = await f.evidence();
      assert.ok(result.kind === 'ok' && result.goal.kind === 'verified');
      if (result.kind === 'ok' && result.goal.kind === 'verified') assert.equal(result.goal.objective.sources.length, 2);
    } finally { fs.open = originalOpen; await f.close(); }
  });
}
