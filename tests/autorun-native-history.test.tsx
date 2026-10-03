import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutorunHistory } from '../src/components/automation/autorun-history';
import { runFixture } from './fixtures/automation';
import { autorunInput, boundary, contextSnapshot } from './fixtures/autorun-contracts';
const callbacks = { onResolve() {}, onOpenSession() {}, onEvidence() {} };
const nativeRuns = [
  { ...runFixture(), id: 'bootstrap', occurrenceKey: 'activation:activation-1', state: 'delivered' as const, observedRuntime: 'input-required' as const, sessionId: null },
  { ...runFixture(), id: 'approval', occurrenceKey: 'approval:request-1:hash', state: 'cancelled' as const, observedRuntime: 'input-required' as const, reason: 'APPROVAL_STALE', sessionId: null },
];
const decision = { id: 'decision-1', automationId: 'rule-1', automationRevision: 1, goalRevision: 1, boundaryId: boundary.id,
  phase: 'decided' as const, outcome: 'complete' as const, reason: null, coverage: contextSnapshot().coverage,
  supervisorSelection: autorunInput().autorun.supervisor, cliVersion: '0.159.2', runId: null, delivery: 'not-requested' as const,
  createdAt: boundary.completedAt, finishedAt: boundary.completedAt, retryAt: null, analysisAttempts: 1 };

test('Autorun displays native bootstrap and cancelled approval runs when continuation decisions are empty', () => {
  const html = renderToStaticMarkup(createElement(AutorunHistory, { ...callbacks, decisions: [], runs: nativeRuns }));
  assert.doesNotMatch(html, /No runs yet/);
  assert.match(html, /Delivery recorded/);
  assert.match(html, /Cancelled/);
  assert.match(html, /APPROVAL_STALE/);
  assert.equal((html.match(/<article/g) ?? []).length, 2);
});

test('native runs and continuation decisions both remain visible; only an entirely empty history says no runs', () => {
  const html = renderToStaticMarkup(createElement(AutorunHistory, { ...callbacks, decisions: [decision], runs: nativeRuns }));
  assert.match(html, /Delivery recorded/);
  assert.match(html, /View evidence/);
  assert.doesNotMatch(html, /No runs yet/);
  const empty = renderToStaticMarkup(createElement(AutorunHistory, { ...callbacks, decisions: [], runs: [] }));
  assert.equal((empty.match(/No runs yet/g) ?? []).length, 1);
});

test('Autorun More loads existing native run and decision cursors independently', async () => {
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { loadMoreAutomationHistory } = await import('../src/components/automation/automation-manager');
  const requests: string[] = [];
  const store = createAutomationStore({ sessionId: 'session-1' }, async url => {
    requests.push(String(url));
    return Response.json({ items: String(url).includes('/decisions') ? [decision] : [nativeRuns[1]], nextCursor: null });
  });
  store.setState({ runs: { 'rule-1': { items: [nativeRuns[0]], nextCursor: 'run-cursor' } }, decisions: { 'rule-1': { items: [], nextCursor: 'decision-cursor' } } });
  await loadMoreAutomationHistory(store, 'rule-1', 'autorun');
  assert.deepEqual(requests.sort(), ['/api/automations/rule-1/decisions?cursor=decision-cursor', '/api/automations/rule-1/runs?cursor=run-cursor']);
  assert.equal(store.getState().runs['rule-1'].items.length, 2);
  assert.equal(store.getState().decisions['rule-1'].items[0].id, 'decision-1');
  await loadMoreAutomationHistory(store, 'rule-1', 'autorun');
  assert.equal(requests.length, 2, 'Exhausted cursors do not repeat a page');
  store.setState({ runs: { 'rule-1': { items: [nativeRuns[0]], nextCursor: 'native-only' } } });
  await loadMoreAutomationHistory(store, 'rule-1', 'autorun');
  assert.equal(requests.at(-1), '/api/automations/rule-1/runs?cursor=native-only');
});
