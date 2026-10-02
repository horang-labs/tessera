import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { autorunPreviewFixture } from './fixtures/autorun-contracts';
import { autorunPreviewSchema } from '../src/lib/automation/autorun-contracts';

test('setup separates missing objective from unsafe completed context and idle human handoff', async () => {
  const { AutorunPreviewView } = await import('../src/components/automation/autorun-setup');
  for (const readiness of [{ kind: 'idle', reason: 'consumed-boundary' }, { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'malformed' }] as const) {
    const preview = autorunPreviewSchema.parse({ ...autorunPreviewFixture(), objective: null, readiness });
    const html = renderToStaticMarkup(createElement(AutorunPreviewView, { preview, objectiveOverride: 'My explicit goal', onObjective: () => {}, onOpenSession: () => {} }));
    assert.match(html, /Set by you/);
    assert.match(html, readiness.kind === 'idle' ? /Send a new instruction/ : /Latest worker context unavailable/);
  }
});

test('accepted first running turn can start without completed context; override cannot bypass unsafe or consumed readiness', async () => {
  const { autorunCanStart } = await import('../src/components/automation/autorun-setup');
  const { hookSubmissionFixture, boundary } = await import('./fixtures/autorun-contracts');
  const base = autorunPreviewFixture();
  const running = autorunPreviewSchema.parse({ ...base, objective: null, readiness: { kind: 'running',
    acceptedTurn: { serverInstanceId: boundary.serverInstanceId, terminalId: boundary.terminalId, generation: 1, sessionId: 'session-1', userId: 'owner-1', turnSequence: 2, inputRevision: 3 }, submission: hookSubmissionFixture().evidence } });
  assert.equal(autorunCanStart(running, running.recommendedSupervisor, 'Explicit objective', base.defaults.expiresAt, boundary.completedAt), true);
  assert.equal(autorunCanStart(running, running.recommendedSupervisor, '', base.defaults.expiresAt, boundary.completedAt), false);
  for (const readiness of [{ kind: 'idle', reason: 'consumed-boundary' }, { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'malformed' }] as const) {
    const blocked = autorunPreviewSchema.parse({ ...base, readiness });
    assert.equal(autorunCanStart(blocked, blocked.recommendedSupervisor, 'Explicit objective', base.defaults.expiresAt, boundary.completedAt), false);
  }
  assert.equal(autorunCanStart(running, { ...running.recommendedSupervisor!, model: 'unproven' }, 'Goal', base.defaults.expiresAt, boundary.completedAt), false);
});

test('new setup prefers the exact available worker selection, while an unavailable saved supervisor is retained for correction', async () => {
  const { chooseAutorunSupervisor } = await import('../src/components/automation/autorun-setup');
  const base = autorunPreviewSchema.parse(autorunPreviewFixture());
  const unavailable = { ...base.recommendedSupervisor!, model: 'old-model' };
  assert.deepEqual(chooseAutorunSupervisor(base, unavailable), unavailable);
  assert.deepEqual(chooseAutorunSupervisor(base), base.recommendedSupervisor);
});
