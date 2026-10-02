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

test('Heartbeat Resume is available when only Autorun supervisor/context is unavailable, but consumed idle remains blocked', async () => {
  const { ContinuationResume } = await import('../src/components/automation/continuation-resume');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { applySessionInputOwnership } = await import('../src/lib/automation/client-state');
  const { automationFixture, ownershipFixture, automationNow } = await import('./fixtures/automation');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  const rule = decodeAutomation({ ...automationFixture(), state: 'paused' });
  assert.ok(rule.success);
  applySessionInputOwnership({ ...ownershipFixture(), mode: 'human', automationId: null });
  const store = createAutomationStore({ sessionId: 'session-1' });
  // Preserve lifetime validity without changing a live clock.
  rule.data.limits.expiresAt = Date.now() + 3600000;
  for (const readiness of [{kind:'unavailable',code:'SUPERVISOR_UNSUPPORTED',reason:'unsupported-version'}, {kind:'unavailable',code:'CONTEXT_UNAVAILABLE',reason:'malformed'}, {kind:'unavailable',code:'CONTEXT_UNAVAILABLE',reason:'unsafe-runtime'}, {kind:'idle',reason:'consumed-boundary'}] as const) {
    const preview = autorunPreviewSchema.parse({ ...autorunPreviewFixture(), readiness, defaults: { ...autorunPreviewFixture().defaults, expiresAt: automationNow + 28800000 } });
    const html = renderToStaticMarkup(createElement(ContinuationResume, { preview, loading: false, rule: rule.data, store, onDone:()=>{}, onOpenSession:()=>{}, onEdit:()=>{} }));
    const button = html.match(/<button[^>]*>Resume<\/button>/)?.[0];
    assert.ok(button);
    assert.equal( /\sdisabled(?:=|>)/.test(button), readiness.kind === 'idle' || readiness.reason === 'unsafe-runtime');
  }
});

test('schedule title is a bounded deterministic first-line suggestion and retained form fields restore on reopening', async () => {
  const { AutomationForm, suggestSessionTitle } = await import('../src/components/automation/automation-form');
  assert.equal(suggestSessionTitle('  Review   login changes\nThen verify tests.'), 'Review login changes');
  const html = renderToStaticMarkup(createElement(AutomationForm, {scope:{worktreeId:'wt-1'}, onSave:async()=>true, onCancel:()=>{}, draft:{prompt:'Review login changes',title:'Saved title',at:'2030-01-01T18:00',trigger:'interval',every:'45',provider:'codex',model:'saved-model',effort:'high',tier:'fast',max:'7',expiry:'2030-01-02T18:00',name:'Saved schedule'}}));
  assert.match(html,/value="2030-01-01T18:00"/); assert.match(html,/value="45"/); assert.match(html,/value="7"/); assert.match(html,/Saved title/);
  assert.ok(html.indexOf('name="prompt"') < html.indexOf('name="name"'));
  assert.match(html,/codex.*saved-model.*high.*fast/);
});


test('attention without a protocol reason still shows the owner decision blocker', async () => {
  const { AutomationReason } = await import('../src/components/automation/automation-reason');
  const html = renderToStaticMarkup(createElement(AutomationReason, { reason: null, summary: 'Choose whether to preserve the legacy login flow.' }));
  assert.match(html, /Choose whether to preserve the legacy login flow/);
});


test('Heartbeat cannot resume without a checked runtime preview', async () => {
  const { ContinuationResume } = await import('../src/components/automation/continuation-resume');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { automationFixture } = await import('./fixtures/automation');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  const rule = decodeAutomation({ ...automationFixture(), state: 'paused' });
  assert.ok(rule.success); rule.data.limits.expiresAt = Date.now()+3600000;
  const html = renderToStaticMarkup(createElement(ContinuationResume, {preview:null,loading:false,rule:rule.data,store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{},onEdit:()=>{}}));
  assert.match(html.match(/<button[^>]*>Resume<\/button>/)?.[0] ?? '', /disabled/);
});
