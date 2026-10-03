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
    assert.match(html, /<textarea[^>]*required/);
    assert.match(html, /My explicit goal/);
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
  assert.match(html,/name="provider"/); assert.match(html,/name="effort"/);
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


test('objective heading attributes only verified sources or a nonblank explicit objective', async () => {
  const { AutorunPreviewView } = await import('../src/components/automation/autorun-setup');
  const base = autorunPreviewFixture();
  const verified = { kind: 'verified-human', text: 'Fix login.', revision: 1, sources: [{ messageId: 'message-1', recordId: 'record-1', excerpt: 'Fix login.', textHash: 'd'.repeat(64), origin: 'tessera-human-correlated' }] };
  const cases = [
    { objective: null, override: '', attribution: 'Not verified' },
    { objective: null, override: '   ', attribution: 'Not verified' },
    { objective: verified, override: '', attribution: 'From verified conversation' },
    { objective: base.objective, override: '', attribution: 'Set by you' },
    { objective: null, override: 'My explicit goal', attribution: 'Set by you' },
    { objective: verified, override: 'My changed goal', attribution: 'Set by you' },
  ];
  for (const { objective, override, attribution } of cases) {
    const preview = autorunPreviewSchema.parse({ ...base, objective });
    const html = renderToStaticMarkup(createElement(AutorunPreviewView, { preview, objectiveOverride: override, onObjective: () => {}, onOpenSession: () => {} }));
    // Inspect the objective heading, not the edit field's explicit-input label.
    assert.equal(html.match(/<h3[^>]*>([^<]+)<\/h3>/)?.[1], 'Objective');
    if (attribution === 'Not verified') assert.doesNotMatch(html, /From verified conversation|Set by you/);
    else assert.ok(html.includes(attribution));
  }
});


test('setup labels actual remaining instruction and analysis budgets and expiry in every locale', async context => {
  const { AutorunSetup, AutorunPreviewView } = await import('../src/components/automation/autorun-setup');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { i18n } = await import('../src/lib/i18n');
  const { boundary } = await import('./fixtures/autorun-contracts');
  context.mock.method(Date, 'now', () => boundary.completedAt);
  const preview = autorunPreviewSchema.parse({ ...autorunPreviewFixture(), objective: null, remaining: { dispatches: 3, analyses: 7 } });
  const locales = [
    { language: 'en', missing: 'Objective · Not verified', instructions: 'Instructions left', analyses: 'Analyses left', expiry: 'Expires' },
    { language: 'ko', missing: '목표 · 확인되지 않음', instructions: '남은 지시', analyses: '남은 분석', expiry: '만료' },
    { language: 'ja', missing: '目標 · 未確認', instructions: '残りの指示', analyses: '残りの分析', expiry: '有効期限' },
    { language: 'zh', missing: '目标 · 未验证', instructions: '剩余指令', analyses: '剩余分析', expiry: '到期' },
  ];
  try {
    for (const { language, missing, instructions, analyses, expiry } of locales) {
      await i18n.changeLanguage(language);
      const html = renderToStaticMarkup(createElement(AutorunSetup, { preview, store: createAutomationStore({ sessionId: 'session-1' }), onDone: () => {}, onOpenSession: () => {} }));
      assert.match(html, /<textarea[^>]*required/);
      assert.doesNotMatch(html, /From verified conversation|Set by you/);
      for (const [label, value] of [[instructions, '3'], [analyses, '7']]) {
        assert.match(html, new RegExp(`<dt[^>]*>${label}</dt>\\s*<dd[^>]*>${value}</dd>`), `Unlabeled or swapped budget in ${language}`);
      }
      assert.match(html, new RegExp(`<dt[^>]*>${expiry}</dt>\\s*<dd`));
      assert.doesNotMatch(html, /automation\.(remainingDispatches|remainingAnalyses|budgetExpiry|unverifiedGoal)/);
      const explicit = renderToStaticMarkup(createElement(AutorunPreviewView, { preview, objectiveOverride: 'User goal', onObjective: () => {}, onOpenSession: () => {} }));
      assert.ok(!explicit.includes(missing), `Explicit override retains missing attribution in ${language}`);
    }
  } finally { await i18n.changeLanguage('en'); }
});


test('shared manager and Session strip Pause follows enabled or held ownership, not retained history', async () => {
  const { AutomationPauseAction } = await import('../src/components/automation/continuation-resume');
  const { automationFixture, ownershipFixture } = await import('./fixtures/automation');
  for (const surface of ['automation', 'chat_header'] as const) {
    for (const state of ['exhausted', 'expired', 'paused', 'deleted', 'disabled', 'enabled'] as const) {
      for (const mode of ['human', 'armed', 'draining', 'recovery-required', 'unavailable'] as const) {
        const html = renderToStaticMarkup(createElement(AutomationPauseAction, {
          rule:{...automationFixture(),state}, ownership:{...ownershipFixture(),mode,automationId:mode === 'human' ? null : 'rule-1'},surface,onPause:()=>{},
        }));
        assert.equal(html.includes('Pause to type'), state === 'enabled' || mode !== 'human', `${surface}/${state}/${mode}`);
        assert.doesNotMatch(html, /disabled="/);
      }
    }
  }
  const schedule = renderToStaticMarkup(createElement(AutomationPauseAction, {rule:{...automationFixture(),state:'enabled'},ownership:{...ownershipFixture(),mode:'human',automationId:null},surface:'automation',schedule:true,onPause:()=>{}}));
  assert.match(schedule, />Pause<\/button>/);
});


test('ended continuation limits offer review before editing, not unchanged Resume', async context => {
  const { ContinuationResume } = await import('../src/components/automation/continuation-resume');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { applySessionInputOwnership } = await import('../src/lib/automation/client-state');
  const { automationFixture, ownershipFixture, automationNow } = await import('./fixtures/automation');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  context.mock.method(Date,'now',()=>automationNow);
  applySessionInputOwnership({...ownershipFixture(),mode:'human',automationId:null});
  const preview=autorunPreviewSchema.parse(autorunPreviewFixture());
  for(const state of ['exhausted','expired'] as const) {
    const rule=decodeAutomation({...automationFixture(),state,dispatchCount:10});assert.ok(rule.success);
    const html=renderToStaticMarkup(createElement(ContinuationResume,{rule:rule.data,preview,loading:false,store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{},onEdit:()=>{}}));
    assert.match(html,/>Review limits and expiry<\/button>/);
    assert.doesNotMatch(html,/>Resume<\/button>/);
    assert.match(html,/<dt[^>]*>Instruction attempts<\/dt>\s*<dd[^>]*>10\/10<\/dd>/);
  }
});


test('Schedule and Autorun spent budgets review limits, while ordinary paused rules explicitly Resume', async context => {
  const { AutomationResumeAction, automationNeedsLimitReview } = await import('../src/components/automation/continuation-resume');
  const { automationFixture, onceInput, automationNow } = await import('./fixtures/automation');
  const { autorunInput } = await import('./fixtures/autorun-contracts');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  const { i18n } = await import('../src/lib/i18n');
  context.mock.method(Date,'now',()=>automationNow);
  const {enabled: _scheduled, ...scheduleInput}=onceInput();void _scheduled;
  const schedule = decodeAutomation({...automationFixture(),...scheduleInput,state:'exhausted',dispatchCount:1});assert.ok(schedule.success);
  const expired = decodeAutomation({...automationFixture(),...scheduleInput,state:'paused',limits:{maxDispatches:1,expiresAt:automationNow}});assert.ok(expired.success);
  const input=autorunInput(); const { enabled: _enabled, ...autorun }=input; void _enabled;
  const {prompt: _prompt,...base}=automationFixture();void _prompt;
  const analysed=decodeAutomation({...base,...autorun,state:'paused',analysisCount:20,latestDecisionId:null,autorunStatus:'paused',attention:null,autorun:{...input.autorun,objective:{...input.autorun.objective,revision:1},criterionOrigin:'explicit'}});
  assert.ok(analysed.success);
  const ordinary=decodeAutomation({...automationFixture(),state:'paused'});assert.ok(ordinary.success);
  for(const rule of [schedule.data,expired.data,analysed.data,ordinary.data]) {
    const review=automationNeedsLimitReview(rule,automationNow);
    const html=renderToStaticMarkup(createElement(AutomationResumeAction,{reviewLimits:review,disabled:false,onReviewLimits:()=>{},onResume:()=>{}}));
    assert.equal(html.includes('Review limits and expiry'),rule !== ordinary.data);
    assert.equal(html.includes('>Resume</button>'),rule === ordinary.data);
  }
  try {
    for(const [language,label] of [['en','Review limits and expiry'],['ko','한도·기간 검토'],['ja','上限・期限を確認'],['zh','查看限额和有效期']]) {
      await i18n.changeLanguage(language);
      const html=renderToStaticMarkup(createElement(AutomationResumeAction,{reviewLimits:true,disabled:true,onReviewLimits:()=>{},onResume:()=>{}}));
      assert.ok(html.includes(label));assert.match(html,/disabled="/);
    }
  } finally { await i18n.changeLanguage('en'); }
});

test('Resume keeps the saved verified objective and source visible alongside fresh readiness and new instructions', async context => {
  const { ContinuationResume } = await import('../src/components/automation/continuation-resume');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { autorunInput, firstRunningEvidenceFixture } = await import('./fixtures/autorun-contracts');
  const { automationFixture, automationNow, ownershipFixture } = await import('./fixtures/automation');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  const { applySessionInputOwnership } = await import('../src/lib/automation/client-state');
  context.mock.method(Date, 'now', () => automationNow);
  applySessionInputOwnership({ ...ownershipFixture(), mode: 'human', automationId: null });
  const { enabled: _enabled, ...input } = autorunInput(); void _enabled;
  const { prompt: _prompt, ...base } = automationFixture(); void _prompt;
  const objective = { ...firstRunningEvidenceFixture().goal.objective, text: 'Preserve the saved billing goal.',
    sources: [{ ...firstRunningEvidenceFixture().goal.objective.sources[0], excerpt: 'Original billing instruction.' }] };
  const rule = decodeAutomation({ ...base, ...input, state: 'paused', analysisCount: 0, latestDecisionId: null,
    autorunStatus: 'paused', attention: null, autorun: { ...input.autorun, objective, criterionOrigin: 'verified-human' } });
  assert.ok(rule.success);
  for (const freshObjective of [null, { kind: 'explicit', text: 'Different fresh preview goal.', revision: 1 }] as const) {
    const preview = autorunPreviewSchema.parse({ ...autorunPreviewFixture(), objective: freshObjective,
      readiness: { kind: 'idle', reason: 'consumed-boundary' },
      newHumanInstructions: [{ ...objective.sources[0], recordId: 'new-record', excerpt: 'New human instruction remains visible.' }] });
    const html = renderToStaticMarkup(createElement(ContinuationResume, { rule: rule.data, preview, loading: false,
      store: createAutomationStore({ sessionId: 'session-1' }), onDone: () => {}, onOpenSession: () => {}, onEdit: () => {} }));
    assert.match(html, /Preserve the saved billing goal\./);
    assert.match(html, /Original billing instruction\./);
    assert.match(html, /From verified conversation/);
    assert.doesNotMatch(html, /name="objective"/);
    assert.match(html, /New human instruction remains visible\./);
    assert.match(html, /Send a new instruction/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Resume<\/button>/);
    assert.doesNotMatch(html, /Different fresh preview goal\./);
  }
});

test('Session automation entry is labelled consistently and keeps held Pause directly reachable', async () => {
  const { AutomationSessionControls } = await import('../src/components/automation/automation-entry');
  const { applySessionInputOwnership } = await import('../src/lib/automation/client-state');
  const { ownershipFixture } = await import('./fixtures/automation');
  for (const mode of ['human', 'draining'] as const) {
    applySessionInputOwnership({ ...ownershipFixture(), mode, automationId: mode === 'human' ? null : 'rule-1' });
    const html = renderToStaticMarkup(createElement(AutomationSessionControls, { sessionId: 'session-1', provider: 'codex' }));
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, />Automation<\/span>/);
    assert.equal(html.includes('data-ph-capture-attribute-control="automation.pause"'), mode === 'draining');
    assert.doesNotMatch(html, /Human input available|Draining automatic input|Continue this work/);
  }
});

test('preflight distinguishes checking setup from execution and offers retry only after failure', async () => {
  const { AutomationPreflight } = await import('../src/components/automation/automation-preflight');
  const checking = renderToStaticMarkup(createElement(AutomationPreflight, { loading: true, error: null, onRetry: () => {} }));
  assert.match(checking, /aria-busy="true"/);
  assert.match(checking, /Automation has not started/);
  assert.doesNotMatch(checking, /<button/);
  const failed = renderToStaticMarkup(createElement(AutomationPreflight, { loading: false, error: 'PREVIEW_TIMEOUT', onRetry: () => {} }));
  assert.match(failed, /role="alert"/); assert.match(failed, /took too long/); assert.match(failed, />Check again<\/button>/);
  assert.equal(renderToStaticMarkup(createElement(AutomationPreflight, { loading: false, error: null, onRetry: () => {} })), '');
});

test('supervisor discovery offers real model/effort choices but never authorizes Start or replaces an unavailable saved tuple', async () => {
  const { SupervisorPicker } = await import('../src/components/automation/supervisor-picker');
  const { AutorunSetup, autorunCanStart } = await import('../src/components/automation/autorun-setup');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { boundary } = await import('./fixtures/autorun-contracts');
  const selected = { provider: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'xhigh', serviceTier: 'fast' as const };
  const preview = autorunPreviewSchema.parse({ ...autorunPreviewFixture(), recommendedSupervisor: null, supervisorOptions: [],
    supervisorDiscovery: { complete: true, candidates: [{ ...autorunPreviewFixture().supervisorDiscovery.candidates[0], model: selected.model, label: 'GPT-6-Astra', reasoningEfforts: ['low','high','xhigh'], serviceTiers: ['default','fast'] }] },
    supervisorCheck: { selection: selected, status: 'unavailable', reason: 'selection' } });
  const html = renderToStaticMarkup(createElement(SupervisorPicker, { candidates: preview.supervisorDiscovery.candidates, value: selected, onChange: () => {} }));
  assert.match(html, /<option value="gpt-6-astra" selected="">GPT-6-Astra/);
  for (const value of ['low','high','xhigh','fast']) assert.ok(html.includes(`value="${value}"`));
  assert.equal(autorunCanStart(preview, selected, 'Goal', preview.defaults.expiresAt, boundary.completedAt), false);
  const setup = renderToStaticMarkup(createElement(AutorunSetup, { preview, store: createAutomationStore({sessionId:'session-1'}), onDone:()=>{}, onOpenSession:()=>{} }));
  assert.match(setup, /value="xhigh" selected/); assert.match(setup, /This supervisor is unavailable/);
  assert.match(setup, /<button[^>]*disabled=""[^>]*>Start continuation<\/button>/);
  const missing = renderToStaticMarkup(createElement(SupervisorPicker, { candidates: [], value: selected, onChange:()=>{} }));
  assert.match(missing, /value="gpt-6-astra" selected/); assert.match(missing, /value="xhigh" selected/);
  const stale = autorunPreviewSchema.parse({ ...preview, supervisorCheck: { selection: autorunPreviewFixture().recommendedSupervisor, status:'available', reason:null }, supervisorOptions: autorunPreviewFixture().supervisorOptions });
  assert.equal(autorunCanStart(stale, selected, 'Goal', preview.defaults.expiresAt, boundary.completedAt), false);
});
