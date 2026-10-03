import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnershipActions } from '../src/components/automation/ownership-actions';
import { ownershipFixture } from './fixtures/automation';

test('failed create and generic request errors never claim a persisted paused rule',async()=>{
  const {AutomationError}=await import('../src/components/automation/automation-error');
  for(const code of ['NOT_FOUND','INVALID_AUTOMATION','NETWORK_ERROR','INVALID_RESPONSE']){
    const html=renderToStaticMarkup(createElement(AutomationError,{code}));
    assert.doesNotMatch(html,/Automation paused|before resuming|was not accepted/);
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


test('Heartbeat summarizes restored timing while keeping limits inspectable behind one disclosure',async()=>{
  const {AutomationForm}=await import('../src/components/automation/automation-form');
  for(const draft of [undefined,{delay:'45',max:'3',expiry:'2030-01-02T12:30'}]){
    const html=renderToStaticMarkup(createElement(AutomationForm,{scope:{sessionId:'heartbeat'},draft,onSave:async()=>true,onCancel(){}}));
    const summary=html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? '';
    assert.match(summary,draft ? /45s delay/ : /120s delay/);
    assert.match(summary,draft ? /3 instructions/ : /10 instructions/);assert.match(html,/Expires/);
    if(draft)assert.match(html,/2030/);
    assert.doesNotMatch(html,/<details open/);
  }
});

test('native Codex catalog offers Fast as the frozen fast value and never leaks priority into form data',async()=>{
  const {AutomationTierSelect}=await import('../src/components/automation/automation-form');
  const model={value:'gpt-6.1-sol',label:'GPT',isDefault:true,supportedReasoningEfforts:[],defaultServiceTier:null,
    serviceTiers:[{value:'priority',label:'Fast',description:'Native Fast'},{value:'unknown',label:'Unsupported',description:'Unknown'}]};
  const html=renderToStaticMarkup(createElement(AutomationTierSelect,{model,value:'fast',onChange(){}}));
  assert.match(html,/<option value="default">Default/);assert.match(html,/<option value="fast" selected="">Fast/);
  assert.doesNotMatch(html,/priority|Unsupported/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(AutomationTierSelect,{model:{...model,serviceTiers:[]},value:'default',onChange(){}})),/value="fast"/);
});


test('edited Heartbeat summary uses the same restored values as its fields',async()=>{
  const {AutomationForm}=await import('../src/components/automation/automation-form');
  const {automationFixture}=await import('./fixtures/automation');
  const previous={...automationFixture(),trigger:{kind:'turn-complete' as const,delayMs:45000},limits:{maxDispatches:3,expiresAt:Date.UTC(2030,0,2,12,30)}};
  const html=renderToStaticMarkup(createElement(AutomationForm,{scope:{sessionId:'heartbeat'},previous,onSave:async()=>true,onCancel(){}}));
  const summary=html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? '';assert.match(summary,/45s delay/);assert.match(summary,/3 instructions/);assert.match(html,/2030/);
  assert.match(html,/name="delay"[^>]*value="45"/);assert.match(html,/name="max"[^>]*value="3"/);
});
