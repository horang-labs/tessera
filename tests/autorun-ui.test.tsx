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

test('valid activation intent is independent of pending native readiness and exact attestation', async () => {
  const { autorunCanStart } = await import('../src/components/automation/autorun-setup');
  const { hookSubmissionFixture, boundary } = await import('./fixtures/autorun-contracts');
  const base = autorunPreviewFixture();
  const running = autorunPreviewSchema.parse({ ...base, objective: null, readiness: { kind: 'running',
    acceptedTurn: { serverInstanceId: boundary.serverInstanceId, terminalId: boundary.terminalId, generation: 1, sessionId: 'session-1', userId: 'owner-1', turnSequence: 2, inputRevision: 3 }, submission: hookSubmissionFixture().evidence } });
  assert.equal(autorunCanStart(running, running.recommendedSupervisor, 'Explicit objective', base.defaults.expiresAt, boundary.completedAt), true);
  assert.equal(autorunCanStart(running, running.recommendedSupervisor, '', base.defaults.expiresAt, boundary.completedAt), false);
  for (const readiness of [{ kind: 'idle', reason: 'consumed-boundary' }, { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'malformed' }] as const) {
    const blocked = autorunPreviewSchema.parse({ ...base, readiness });
    assert.equal(autorunCanStart(blocked, blocked.recommendedSupervisor, 'Explicit objective', base.defaults.expiresAt, boundary.completedAt), true);
  }
  assert.equal(autorunCanStart(running, { ...running.recommendedSupervisor!, model: 'unproven' }, 'Goal', base.defaults.expiresAt, boundary.completedAt), true);
});

test('new setup prefers the exact available worker selection, while an unavailable saved supervisor is retained for correction', async () => {
  const { chooseAutorunSupervisor } = await import('../src/components/automation/autorun-setup');
  const base = autorunPreviewSchema.parse(autorunPreviewFixture());
  const unavailable = { ...base.recommendedSupervisor!, model: 'old-model' };
  assert.deepEqual(chooseAutorunSupervisor(base, unavailable), unavailable);
  assert.deepEqual(chooseAutorunSupervisor(base), base.recommendedSupervisor);
});

test('Heartbeat Resume registers intent for idle or unavailable native readiness', async () => {
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
    assert.equal( /\sdisabled(?:=|>)/.test(button), false);
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


test('Heartbeat can register Resume without a runtime preview', async () => {
  const { ContinuationResume } = await import('../src/components/automation/continuation-resume');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { automationFixture } = await import('./fixtures/automation');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  const rule = decodeAutomation({ ...automationFixture(), state: 'paused' });
  assert.ok(rule.success); rule.data.limits.expiresAt = Date.now()+3600000;
  const html = renderToStaticMarkup(createElement(ContinuationResume, {preview:null,loading:false,rule:rule.data,store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{},onEdit:()=>{}}));
  assert.doesNotMatch(html.match(/<button[^>]*>Resume<\/button>/)?.[0] ?? '', /\sdisabled(?:=|\s|>)/);
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


test('setup shows localized used and remaining counts only for saved rules, with one editable expiry', async context => {
  const { AutorunSetup } = await import('../src/components/automation/autorun-setup');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { i18n } = await import('../src/lib/i18n');
  const { autorunInput, boundary } = await import('./fixtures/autorun-contracts');
  const { automationFixture } = await import('./fixtures/automation');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  context.mock.method(Date, 'now', () => boundary.completedAt);
  const preview = autorunPreviewSchema.parse(autorunPreviewFixture());
  const { enabled: _enabled, ...input } = autorunInput(); void _enabled;
  const { prompt: _prompt, ...base } = automationFixture(); void _prompt;
  const previous = decodeAutomation({...base,...input,state:'paused',dispatchCount:7,analysisCount:13,latestDecisionId:null,autorunStatus:'paused',attention:null,
    autorun:{...input.autorun,objective:preview.objective,criterionOrigin:'system-objective'}});
  assert.ok(previous.success);
  try {
    for (const [language, used, remaining] of [['en','used','remaining'],['ko','회 사용','회 남음'],['ja','回使用','回'],['zh','已用','剩余']]) {
      await i18n.changeLanguage(language);
      const html = renderToStaticMarkup(createElement(AutorunSetup, {preview,previous:previous.data,intent:'edit',store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{}}));
      assert.ok(html.includes(used) && html.includes(remaining), language);
      assert.match(html, /name="max"[^>]*value="10"/); assert.match(html, /name="analyses"[^>]*value="20"/);
      assert.equal((html.match(/name="expiry"/g) ?? []).length,1);
      assert.doesNotMatch(html, /automation\.(usedRemaining|supervisorChecks|expiry)/);
      const fresh = renderToStaticMarkup(createElement(AutorunSetup, {preview,store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{}}));
      assert.doesNotMatch(fresh, /<dt/); // No duplicate fresh-budget cards beside editable controls.
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
    assert.doesNotMatch(html, /Send a new worker instruction before resuming/);
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Resume<\/button>/);
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

test('supervisor choices register exact intent without replacing unavailable saved tuples or attesting capability', async () => {
  const { SupervisorControls } = await import('../src/components/automation/supervisor-picker');
  const { AutorunSetup, autorunCanStart } = await import('../src/components/automation/autorun-setup');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const { boundary } = await import('./fixtures/autorun-contracts');
  const selected = { provider: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'xhigh', serviceTier: 'fast' as const };
  const preview = autorunPreviewSchema.parse({ ...autorunPreviewFixture(), recommendedSupervisor: null, supervisorOptions: [],
    supervisorDiscovery: { complete: true, candidates: [{ ...autorunPreviewFixture().supervisorDiscovery.candidates[0], model: selected.model, label: 'GPT-6-Astra', reasoningEfforts: ['low','high','xhigh'], serviceTiers: ['default','fast'] }] },
    supervisorCheck: { selection: selected, status: 'unavailable', reason: 'selection' } });
  const html = renderToStaticMarkup(createElement(SupervisorControls, { catalog: {providerId:'codex',displayName:'Codex',supportsReasoningEffort:true,runtimeEffortChange:true,permissionMappings:[],modeOptions:[],accessOptions:[],planLocksAccess:false,modelOptions:[{value:'gpt-6-astra',label:'GPT-6-Astra',isDefault:false,supportedReasoningEfforts:['low','high','xhigh'].map(value=>({value,label:value,description:''})),serviceTiers:[{value:'priority',label:'Fast',description:''}]}]}, value: selected, onChange: () => {} }));
  assert.match(html, /<option value="gpt-6-astra" selected="">GPT-6-Astra/);
  for (const value of ['low','high','xhigh','fast']) assert.ok(html.includes(`value="${value}"`));
  assert.equal(autorunCanStart(preview, selected, 'Goal', preview.defaults.expiresAt, boundary.completedAt), true);
  const setup = renderToStaticMarkup(createElement(AutorunSetup, { preview, store: createAutomationStore({sessionId:'session-1'}), onDone:()=>{}, onOpenSession:()=>{} }));
  assert.match(setup, /value="xhigh" selected/); assert.match(setup, /This model could not be verified/);
  assert.doesNotMatch(setup, /<button[^>]*disabled=""[^>]*>Start Autorun<\/button>/);
  const missing = renderToStaticMarkup(createElement(SupervisorControls, { catalog: null, value: selected, onChange:()=>{} }));
  assert.match(missing, /value="gpt-6-astra" selected/); assert.match(missing, /value="xhigh" selected/);
  const stale = autorunPreviewSchema.parse({ ...preview, supervisorCheck: { selection: autorunPreviewFixture().recommendedSupervisor, status:'available', reason:null }, supervisorOptions: autorunPreviewFixture().supervisorOptions });
  assert.equal(autorunCanStart(stale, selected, 'Goal', preview.defaults.expiresAt, boundary.completedAt), true);
});

test('selected supervisor failure identifies the selector, while worker context failure retains its Session recovery', async () => {
  const { AutorunSetup } = await import('../src/components/automation/autorun-setup');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const base = autorunPreviewFixture();
  const preview = autorunPreviewSchema.parse({ ...base, supervisorOptions: [], recommendedSupervisor: null,
    supervisorCheck: { selection: base.recommendedSupervisor, status: 'unavailable', reason: 'selection' },
    readiness: { kind: 'unavailable', code: 'SUPERVISOR_UNSUPPORTED', reason: 'unsupported-version' } });
  const html = renderToStaticMarkup(createElement(AutorunSetup, {preview,store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{}}));
  assert.match(html, /This model could not be verified/);
  assert.doesNotMatch(html, /Latest worker context unavailable/);
  const { ContinuationResume } = await import('../src/components/automation/continuation-resume');
  const { decodeAutomation } = await import('../src/lib/automation/autorun-contracts');
  const { autorunInput } = await import('./fixtures/autorun-contracts');
  const { automationFixture } = await import('./fixtures/automation');
  const { enabled: _enabled, ...input } = autorunInput(); void _enabled;
  const { prompt: _prompt, ...saved } = automationFixture(); void _prompt;
  const rule = decodeAutomation({ ...saved, ...input, state:'paused', analysisCount:0,latestDecisionId:null,autorunStatus:'paused',attention:null,
    autorun:{...input.autorun,objective:base.objective,criterionOrigin:'system-objective'} });
  assert.ok(rule.success);
  const resume = renderToStaticMarkup(createElement(ContinuationResume,{preview,loading:false,rule:rule.data,store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{},onEdit:()=>{}}));
  assert.match(resume,/This model could not be verified/); assert.doesNotMatch(resume,/Latest worker context unavailable/);

  const context = autorunPreviewSchema.parse({...preview,readiness:{kind:'unavailable',code:'CONTEXT_UNAVAILABLE',reason:'unsafe-runtime'}});
  const blocked = renderToStaticMarkup(createElement(AutorunSetup, {preview:context,store:createAutomationStore({sessionId:'session-1'}),onDone:()=>{},onOpenSession:()=>{}}));
  assert.match(blocked,/CONTEXT_UNAVAILABLE/);assert.doesNotMatch(blocked,/Send a new worker instruction/);
});

test('setup remains editable before readiness arrives without granting Start or Save', async () => {
  const { AutorunSetup } = await import('../src/components/automation/autorun-setup');
  const { createAutomationStore } = await import('../src/stores/automation-store');
  const store = createAutomationStore({sessionId:'session-1'});
  store.setState({previewLoading:true});
  const html = renderToStaticMarkup(createElement(AutorunSetup,{preview:null,store,onDone:()=>{},onOpenSession:()=>{}}));
  assert.match(html, /name="objective"[^>]*required/);
  assert.match(html, /name="supervisorModel"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start Autorun<\/button>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*name="objective"[^>]*>/)?.[0] ?? '', /\sdisabled(?:=|\s|>)/);
});


test('explicit objective recovery preserves existing human draft and refuses approval or held input', async () => {
  const { addAutomationObjectiveToDraft } = await import('../src/components/automation/automation-entry');
  const { useChatStore } = await import('../src/stores/chat-store');
  const { useTerminalSessionStore } = await import('../src/stores/terminal-session-store');
  const { applySessionInputOwnership } = await import('../src/lib/automation/client-state');
  const { ownershipFixture } = await import('./fixtures/automation');
  useChatStore.getState().setDraftInput('session-1','Keep my draft.');
  applySessionInputOwnership({...ownershipFixture(),mode:'human',automationId:null});
  assert.equal(addAutomationObjectiveToDraft('session-1','Fix billing.'),true);
  assert.equal(useChatStore.getState().getDraftInput('session-1'),'Keep my draft.\n\nFix billing.');
  applySessionInputOwnership({...ownershipFixture(),mode:'draining'});
  assert.equal(addAutomationObjectiveToDraft('session-1','Do not insert.'),false);
  applySessionInputOwnership({...ownershipFixture(),mode:'human',automationId:null});
  useTerminalSessionStore.setState({bySessionId:{'session-1':{status:'input_required',hookEvent:'permission',terminalId:'term-1',updatedAt:1}}});
  assert.equal(addAutomationObjectiveToDraft('session-1','Do not insert.'),false);
  assert.equal(useChatStore.getState().getDraftInput('session-1'),'Keep my draft.\n\nFix billing.');
  useTerminalSessionStore.setState({bySessionId:{}});
});

test('a retained objective never replaces fresh human corrections from a missing-goal preview', async () => {
  const { AutorunPreviewView } = await import('../src/components/automation/autorun-setup');
  const objective={kind:'explicit' as const,text:'Retained billing goal.',revision:1};
  const preview=autorunPreviewSchema.parse({...autorunPreviewFixture(),objective:null,newHumanInstructions:[{messageId:'m2',recordId:'r2',excerpt:'Preserve invoices too.',textHash:'d'.repeat(64),origin:'tessera-human-correlated'}]});
  const html=renderToStaticMarkup(createElement(AutorunPreviewView,{preview,objectiveSnapshot:objective,objectiveOverride:'',objectiveEdited:false,onObjective:()=>{},onOpenSession:()=>{}}));
  assert.match(html,/Retained billing goal\./);assert.match(html,/Preserve invoices too\./);
});
