import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunPreviewInputSchema, autorunPreviewSchema } from '../src/lib/automation/autorun-contracts';
import { autorunPreviewFixture, autorunInput } from './fixtures/autorun-contracts';

test('preview accepts an explicit alternate supervisor and distinguishes candidates from checked authority', () => {
  const selection = { ...autorunInput().autorun.supervisor, model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
  assert.equal(autorunPreviewInputSchema.safeParse({ supervisor: selection }).success, true);
  const preview = { ...autorunPreviewFixture(), supervisorOptions: [], recommendedSupervisor: null,
    supervisorDiscovery: { candidates: [{ provider: 'codex', model: selection.model, label: 'Astra',
      reasoningEfforts: ['high', 'xhigh'], serviceTiers: ['default'], source: 'native', unavailableReason: null }], complete: true },
    supervisorCheck: { selection, status: 'unavailable', reason: 'metadata-drift' } };
  assert.equal(autorunPreviewSchema.safeParse(preview).success, true);
  assert.equal(autorunPreviewSchema.safeParse({ ...preview, supervisorCheck: { selection, status: 'available', reason: null } }).success, false);
});
