import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAutomationManagerOpening, heartbeatSetupSubmission } from '../src/components/automation/automation-manager';
import { ContinuationResume } from '../src/components/automation/continuation-resume';
import { createAutomationStore } from '../src/stores/automation-store';
import { automationFixture, automationNow, wakeInput, ownershipFixture } from './fixtures/automation';
import { applySessionInputOwnership } from '../src/lib/automation/client-state';

test('fresh Heartbeat Start then Pause does not reapply changed opening hints or lose saved limits', async context => {
  context.mock.method(Date, 'now', () => automationNow);
  const input = { ...wakeInput(), enabled: true, trigger: { kind: 'turn-complete' as const, delayMs: 30_000 }, limits: { maxDispatches: 1, expiresAt: automationNow + 600_000 } };
  const { enabled: _enabled, ...config } = input; void _enabled;
  let rule = { ...automationFixture(), ...config, version: 2, mode: 'heartbeat', state: 'enabled', revision: 1 };
  const store = createAutomationStore({ sessionId: 'session-1' }, async (url, init) => {
    if (String(url).endsWith('/automation-input')) return Response.json({ ok: true });
    if (init?.method === 'POST') {
      if (String(url).endsWith('/state')) rule = { ...rule, state: 'paused', revision: 2 };
      return Response.json({ automation: rule, inputOwnership: { ...ownershipFixture(), mode: 'human', automationId: null }, inFlightRunId: null });
    }
    return Response.json({ items: [rule], nextCursor: null });
  });
  const opening = createAutomationManagerOpening();
  opening(store, undefined, false); // Opened before a rule exists.
  const save = heartbeatSetupSubmission(store, 'start', 'session-1', undefined, id => store.setState({ view: { selectedId: id, tab: 'overview', setup: false } }));
  assert.equal(await save.onSave(input), true);
  assert.equal(await store.getState().pause('rule-1'), true);
  applySessionInputOwnership({ ...ownershipFixture(), mode: 'human', automationId: null });
  opening(store, 'rule-1', true); // Parent header now sees a paused rule; this is the SAME open dialog.
  assert.deepEqual(store.getState().view, { selectedId: 'rule-1', tab: 'overview', setup: false });
  const saved = store.getState().details['rule-1'].automation;
  assert.equal(saved.state, 'paused');
  assert.deepEqual(saved.trigger, { kind: 'turn-complete', delayMs: 30_000 });
  assert.equal(saved.limits.maxDispatches, 1);
  const html = renderToStaticMarkup(createElement(ContinuationResume, { preview: null, loading: false, rule: saved, store, onDone() {}, onOpenSession() {}, onEdit() {} }));
  assert.match(html, />Resume<\/button>/);
  assert.match(html, />0\/1<\/dd>/);
  assert.doesNotMatch(html, /Start Heartbeat|name="prompt"/);
  // A new opening may intentionally enter Resume; only live updates are ignored.
  createAutomationManagerOpening()(store, 'rule-1', true);
  assert.equal(store.getState().view.setup, true);
});
