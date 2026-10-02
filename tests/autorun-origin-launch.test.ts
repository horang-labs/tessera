import assert from 'node:assert/strict';
import test from 'node:test';
import { originFixture } from './helpers/autorun-origin-fixture';

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider}: fenced scheduled initial instructions are context, equal-text later human is the objective`, async () => {
    const f = await originFixture(provider, true);
    try {
      assert.equal((await f.launch()).kind, 'delivered');
      await f.native('scheduled', 'Identical instructions'); f.complete();
      const automated = await f.evidence();
      assert.ok(automated.kind === 'ok' && automated.goal.kind === 'missing');
      await f.manager.submitSessionPrompt('session', 'owner', 'Identical instructions');
      await f.native('human', 'Identical instructions');
      const result = await f.evidence();
      assert.ok(result.kind === 'ok' && result.goal.kind === 'verified');
      if (result.kind === 'ok' && result.goal.kind === 'verified') assert.equal(result.goal.objective.sources.length, 1);
      const context = await f.context();
      assert.equal(context.kind, 'ok', JSON.stringify(context));
      if (context.kind === 'ok') assert.equal(context.snapshot.items.filter(i => i.role === 'user').length, 2);
    } finally { await f.close(); }
  });
}
