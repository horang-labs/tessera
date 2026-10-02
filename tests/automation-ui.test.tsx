import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnershipActions } from '../src/components/automation/ownership-actions';
import { ownershipFixture } from './fixtures/automation';

test('failed create and generic request errors never claim a persisted paused rule',async()=>{
  const {AutomationError}=await import('../src/components/automation/automation-error');
  for(const code of ['NOT_FOUND','INVALID_AUTOMATION','NETWORK_ERROR']){
    const html=renderToStaticMarkup(createElement(AutomationError,{code}));
    assert.doesNotMatch(html,/Automation paused|before resuming/);
    assert.match(html,/request/i);assert.match(html,new RegExp(code));assert.match(html,/role="alert"/);
  }
});

test('actual rule pause and typed actionable reasons retain their established presentation',async()=>{
  const {AutomationReason}=await import('../src/components/automation/automation-reason');
  const {AutomationError}=await import('../src/components/automation/automation-error');
  assert.match(renderToStaticMarkup(createElement(AutomationReason,{reason:'user-paused'})),/Automation paused/);
  assert.match(renderToStaticMarkup(createElement(AutomationError,{code:'CONTEXT_UNAVAILABLE'})),/evidence could not be verified/);
  assert.match(renderToStaticMarkup(createElement(AutomationError,{code:'REVISION_CONFLICT'})),/changed in another window/);
});

test('Pause and Delete remain exposed in every locked ownership state', () => {
  for (const mode of ['armed', 'draining', 'recovery-required', 'unavailable'] as const) {
    const html = renderToStaticMarkup(createElement(OwnershipActions, {
      ownership: { ...ownershipFixture(), mode, reason: 'APPROVAL_REQUIRED' },
      automationId: 'rule-1', onPause: () => {}, onDelete: () => {},
    }));
    assert.match(html, /Pause to type/);
    assert.match(html, /Delete automation/);
    assert.doesNotMatch(html, /disabled="|Human input available/);
    assert.match(html, /APPROVAL_REQUIRED/);
  }
});

test('wake form starts opt-in with bounded defaults and leaves the saved prompt empty', async () => {
  const { AutomationForm } = await import('../src/components/automation/automation-form');
  const html = renderToStaticMarkup(createElement(AutomationForm, { scope: { sessionId: 'session-1' }, onSave: async () => true, onCancel: () => {} }));
  assert.match(html, /value="120"/);
  assert.match(html, /value="10"/);
  assert.match(html, /Save for later/);
  assert.match(html, /<textarea[^>]*><\/textarea>/);
  assert.doesNotMatch(html, /type="checkbox" checked/);
});

test('history distinguishes delivered prompts from task success and offers no-retry recovery', async () => {
  const { AutomationHistory } = await import('../src/components/automation/automation-history');
  const { runFixture } = await import('./fixtures/automation');
  const html = renderToStaticMarkup(createElement(AutomationHistory, {
    runs: [{ ...runFixture(), state: 'delivered', coalescedCount: 7 }, { ...runFixture(), id: 'uncertain', state: 'unknown', reason: 'WRITER_UNCERTAIN' }],
    onResolve: () => {}, onOpenSession: () => {},
  }));
  assert.match(html, /Prompt delivered/);
  assert.match(html, /do not mean the task succeeded/);
  assert.match(html, /Take manual control/);
  assert.match(html, /WRITER_UNCERTAIN/);
  assert.match(html, /Open Session/);
  assert.match(html, /Inherited from CLI/);
  assert.match(html, /Omitted overdue slots: 7/);
});

test('editing a retained interval anchor previews the next future slot locally and in UTC', async context => {
  context.mock.method(Date, 'now', () => Date.UTC(2030, 0, 1));
  const { AutomationForm } = await import('../src/components/automation/automation-form');
  const { automationFixture, onceInput } = await import('./fixtures/automation');
  const previous = { ...automationFixture(), ...onceInput(), trigger: { kind: 'interval' as const, anchorAt: Date.UTC(2029, 11, 31, 23, 50), everyMs: 300000 } };
  const html = renderToStaticMarkup(createElement(AutomationForm, { scope: { worktreeId: 'wt-1' }, previous, onSave: async () => true, onCancel: () => {} }));
  assert.match(html, /Next due/);
  assert.match(html, /2030-01-01T00:05:00.000Z/);
  assert.match(html, /UTC/);
});
