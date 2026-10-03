import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { autorunPreviewFixture, boundary } from './fixtures/autorun-contracts';
import { ownershipFixture } from './fixtures/automation';
import { createAutomationStore } from '../src/stores/automation-store';
import { applySessionInputOwnership } from '../src/lib/automation/client-state';
const idle = () => ({ ...autorunPreviewFixture(), objective: null, readiness: { kind: 'idle' as const, reason: 'no-accepted-turn' as const } });

test('fresh idle Autorun with explicit objective and verified exact supervisor offers Start without a prior instruction', async context => {
  context.mock.method(Date, 'now', () => boundary.completedAt);
  applySessionInputOwnership({ ...ownershipFixture(), mode: 'human', automationId: null });
  const { AutorunSetup } = await import('../src/components/automation/autorun-setup');
  const preview = idle();
  const store = createAutomationStore({ sessionId: 'session-1' });
  store.setState({ preview, previewLoading: false, previewError: null, drafts: { 'autorun:new:fields': { objective: '333', objectiveEdited: 'yes' } } });
  const html = renderToStaticMarkup(createElement(AutorunSetup, { preview, store: { ...store, getInitialState: store.getState }, onDone() {}, onOpenSession() {} }));
  assert.match(html, />333<\/textarea>/);
  const start = html.match(/<button[^>]*data-ph-capture-attribute-control="automation.autorun.start"[^>]*>/)?.[0];
  assert.ok(start);
  assert.doesNotMatch(start, /disabled=""/, 'Absence of an accepted prior turn must not disable a valid activation intent');
  assert.doesNotMatch(html, /Send a new worker instruction|Add objective to Session draft/);
});

test('idle Heartbeat with a complete prompt is not trapped by a prior boundary rejection or mandatory draft detour', async context => {
  context.mock.method(Date, 'now', () => boundary.completedAt);
  const { AutomationForm } = await import('../src/components/automation/automation-form');
  const { heartbeatSetupSubmission } = await import('../src/components/automation/automation-manager');
  const { AutomationReadinessRecovery } = await import('../src/components/automation/automation-preflight');
  const preview = idle();
  const store = createAutomationStore({ sessionId: 'session-1' });
  store.setState({ preview, previewLoading: false, previewError: null, previewRejection: 'INPUT_BOUNDARY_UNPROVEN' });
  const actions = heartbeatSetupSubmission(store, 'start', 'session-1', undefined, () => {});
  const html = renderToStaticMarkup(createElement(AutomationForm, { scope: { sessionId: 'session-1' }, draft: { prompt: '222' }, defaultName: 'Heartbeat', ...actions, onCancel() {}, footerNote: createElement(AutomationReadinessRecovery, { preview, method: 'heartbeat', objective: '222', onOpenSession() {}, onDraftObjective() {} }) }));
  assert.match(html, />222<\/textarea>/);
  const start = html.match(/<button[^>]*data-ph-capture-attribute-control="automation.form.save"[^>]*type="submit"[^>]*>/)?.[0];
  assert.ok(start);
  assert.doesNotMatch(start, /disabled=""/, 'A previous missing-boundary rejection must not turn a complete activation form into a dead end');
  assert.doesNotMatch(html, /Send a new worker instruction|Add message to Session draft/);
});

test('Resume registers valid saved intent while runtime checking is pending and human draft ownership is retained', async context => {
  context.mock.method(Date, 'now', () => boundary.completedAt);
  const { ContinuationResume } = await import('../src/components/automation/continuation-resume');
  const { automationFixture } = await import('./fixtures/automation');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  const decoded = decodeAutomation({ ...automationFixture(), state: 'paused' });
  assert.ok(decoded.success);
  applySessionInputOwnership({ ...ownershipFixture(), mode: 'unavailable', automationId: null });
  const store = createAutomationStore({ sessionId: 'session-1' });
  store.setState({ previewLoading: true });
  const html = renderToStaticMarkup(createElement(ContinuationResume, { preview: null, loading: true, rule: decoded.data, store: { ...store, getInitialState: store.getState }, onDone() {}, onOpenSession() {}, onEdit() {} }));
  const resume = html.match(/<button[^>]*>Resume<\/button>/)?.[0];
  assert.ok(resume);
  assert.doesNotMatch(resume, /disabled=""/);
});

test('enabled waiting and approval receipts describe intent without claiming input ownership or blanket approval support', async () => {
  const { AutomationActivationStatus } = await import('../src/components/automation/automation-activation');
  const activation = { activationId: 'activation-1', phase: 'waiting' as const, reason: 'worker-running' as const, approval: null };
  const html = renderToStaticMarkup(createElement(AutomationActivationStatus, { state: 'enabled', mode: 'autorun', activation, onOpenSession() {} }));
  assert.match(html, /Enabled/);
  assert.match(html, /Waiting for the worker/);
  assert.doesNotMatch(html, /Instruction sent|Automation owns input/);
  for (const status of ['reviewing', 'approved-once', 'denied', 'needs-user'] as const) {
    const approval = { requestId: 'request-1', kind: 'command' as const, summary: 'Read package.json', status, explanation: 'Current request only.' };
    const view = renderToStaticMarkup(createElement(AutomationActivationStatus, { state: 'enabled', mode: 'autorun', activation: { ...activation, approval }, onOpenSession() {} }));
    assert.match(view, /Read package.json/);
    assert.match(view, new RegExp(({ reviewing: 'Reviewing approval', 'approved-once': 'Approved once', denied: 'Denied', 'needs-user': 'Needs your answer' })[status]));
    assert.equal(view.includes('>Open Session</button>'), status === 'needs-user');
  }
  const heartbeat = renderToStaticMarkup(createElement(AutomationActivationStatus, { state: 'enabled', mode: 'heartbeat', activation: { ...activation, reason: 'approval-needs-user' }, onOpenSession() {} }));
  assert.match(heartbeat, /Waiting for your approval answer/);
  const paused = renderToStaticMarkup(createElement(AutomationActivationStatus, { state: 'paused', mode: 'autorun', activation, onOpenSession() {} }));
  assert.doesNotMatch(paused, /Waiting for the worker/);
});
