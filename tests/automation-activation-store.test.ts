import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationStore } from '../src/stores/automation-store';
import { automationFixture, wakeInput, ownershipFixture } from './fixtures/automation';
import { applySessionInputOwnership, getSessionInputOwnership } from '../src/lib/automation/client-state';
import { useChatStore } from '../src/stores/chat-store';

test('Start saves one full enabled intent, exposes waiting receipt and preserves draft/human ownership', async () => {
  useChatStore.getState().setDraftInput('session-1', 'my retained draft');
  applySessionInputOwnership({ ...ownershipFixture(), mode: 'human', automationId: null });
  const requests: { url: string; body: unknown }[] = [];
  const enabled = { ...automationFixture(), state: 'enabled' };
  const activation = { activationId: 'activation-1', phase: 'waiting', reason: 'human-draft', approval: null };
  const store = createAutomationStore({ sessionId: 'session-1' }, async (url, init) => {
    if (init?.method === 'POST') {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (String(url).endsWith('/automation-input')) return Response.json({ ok: true });
      return Response.json({ automation: enabled, activation, inputOwnership: null });
    }
    return Response.json({ items: [enabled], nextCursor: null });
  });
  const input = { ...wakeInput(), enabled: true };
  assert.equal(await store.getState().save(input), true);
  assert.deepEqual(requests.filter(r => r.url === '/api/automations'), [{ url: '/api/automations', body: input }]);
  assert.deepEqual(store.getState().details['rule-1']?.activation, activation);
  assert.equal(requests[0].url, '/api/sessions/session-1/automation-input');
  const veto = requests[0].body as { surfaceId: string; revision: number; hasDraft: boolean };
  assert.match(veto.surfaceId, /^composer:/);
  assert.equal(veto.hasDraft, true);
  assert.ok(veto.revision > 0);
  assert.deepEqual(Object.keys(veto).sort(), ['hasDraft', 'revision', 'surfaceId']);
  assert.equal(useChatStore.getState().getDraftInput('session-1'), 'my retained draft');
  assert.equal(getSessionInputOwnership('session-1').mode, 'human');
  assert.equal(await store.getState().pause('rule-1'), true);
  assert.equal(useChatStore.getState().getDraftInput('session-1'), 'my retained draft');
});

test('enable waits for the latest draft veto, never clears a draft, and Pause stays independent of a pending publication', async () => {
  useChatStore.getState().setDraftInput('session-race', '');
  const publications: { body: { revision: number; hasDraft: boolean }; resolve: (value: Response) => void }[] = [];
  const actions: unknown[] = [];
  const rule = { ...automationFixture(), target: { kind: 'wake-session' as const, sessionId: 'session-race' } };
  const store = createAutomationStore({ sessionId: 'session-race' }, async (url, init) => {
    if (String(url).endsWith('/automation-input')) return new Promise<Response>(resolve => publications.push({ body: JSON.parse(String(init?.body)), resolve }));
    if (init?.method === 'POST') { actions.push(JSON.parse(String(init.body))); return Response.json({ automation: rule, inputOwnership: null }); }
    return Response.json({ items: [rule], nextCursor: null });
  });
  const stop = store.getState().watchDraftVeto();
  const enable = store.getState().enable(rule);
  useChatStore.getState().setDraftInput('session-race', '  retained in normal and Peek  ');
  assert.equal(publications.length, 2);
  assert.equal(publications[0].body.hasDraft, false);
  assert.equal(publications[1].body.hasDraft, true);
  assert.ok(publications[1].body.revision > publications[0].body.revision);
  assert.equal(await store.getState().pause(rule.id), true);
  assert.deepEqual(actions, [{ action: 'pause' }]);
  publications[0].resolve(Response.json({ ok: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, [{ action: 'pause' }], 'A stale empty-draft acknowledgement must not release activation');
  publications[1].resolve(Response.json({ ok: true }));
  assert.equal(await enable, false);
  assert.deepEqual(actions, [{ action: 'pause' }], 'Pause cancels an activation which has not been registered yet');
  stop();
  assert.equal(publications.length, 2, 'Unmount never clears a known nonempty draft');
  assert.equal(useChatStore.getState().getDraftInput('session-race'), '  retained in normal and Peek  ');
});

test('actual Autorun submit with no preview sends valid complete input and default criterion; failed draft publication preserves editable fields', async context => {
  const { submitAutorunSetup } = await import('../src/components/automation/autorun-setup');
  const { autorunInput } = await import('./fixtures/autorun-contracts');
  const { validateAutomationInputV2 } = await import('../src/lib/automation/autorun-contracts');
  context.mock.method(Date, 'now', () => 1_800_000_000_000);
  const fields = new FormData();
  for (const [key, value] of Object.entries({ delay: '120', max: '10', analyses: '20', timeout: '120', expiry: '2027-01-16T17:00:00.000Z', constraints: 'Preserve drafts.', criteria: '' })) fields.set(key, value);
  // Exactly one hour ahead of the pinned clock.
  fields.set('expiry', new Date(Date.now() + 3_600_000).toISOString());
  let failedVeto = true;
  const creates: unknown[] = [];
  const store = createAutomationStore({ sessionId: 'session-fresh' }, async (url, init) => {
    if (String(url).endsWith('/automation-input')) return Response.json({}, { status: failedVeto ? 503 : 200 });
    if (init?.method === 'POST') {
      const input = JSON.parse(String(init.body));
      assert.equal(validateAutomationInputV2(input, { now: Date.now() }).success, true);
      creates.push(input);
      const { prompt: _prompt, ...base } = automationFixture(); void _prompt;
      const { enabled: _enabled, ...saved } = input; void _enabled;
      return Response.json({ automation: { ...base, ...saved, state: 'enabled', analysisCount: 0, latestDecisionId: null, autorunStatus: 'waiting', attention: null, autorun: { ...input.autorun, objective: { ...input.autorun.objective, revision: 1 }, criterionOrigin: 'explicit' } }, activation: { activationId: 'activation-fresh', phase: 'waiting', reason: 'supervisor-checking', approval: null }, inputOwnership: null });
    }
    return Response.json({ items: [], nextCursor: null });
  });
  store.setState({ previewLoading: true, drafts: { 'autorun:new:fields': { objective: '333' } } });
  const args = { fields, supervisor: autorunInput().autorun.supervisor, objective: '333', preview: null, sessionId: 'session-fresh', intent: 'start' as const, name: 'Autorun', criterion: 'Judge against the saved objective', saveLater: false, store };
  assert.equal((await submitAutorunSetup(args)).success, false);
  assert.equal(store.getState().error, 'NETWORK_ERROR');
  assert.deepEqual(store.getState().drafts['autorun:new:fields'], { objective: '333' });
  assert.equal(creates.length, 0);
  failedVeto = false;
  assert.equal((await submitAutorunSetup(args)).success, true);
  assert.deepEqual(creates, [{ version: 2, mode: 'autorun', name: 'Autorun', enabled: true, target: { kind: 'wake-session', sessionId: 'session-fresh' }, trigger: { kind: 'turn-complete', delayMs: 120_000 }, limits: { maxDispatches: 10, expiresAt: Date.now() + 3_600_000 }, autorun: { objective: { kind: 'explicit', text: '333' }, constraints: ['Preserve drafts.'], criteria: [{ id: 'goal', text: 'Judge against the saved objective' }], supervisor: autorunInput().autorun.supervisor, maxAnalyses: 20, analysisTimeoutMs: 120_000 } }]);
  assert.equal((await submitAutorunSetup({ ...args, objective: '' })).invalid, true);
  assert.equal((await submitAutorunSetup({ ...args, supervisor: { ...args.supervisor, reasoningEffort: 'auto' } })).invalid, true);
  assert.equal(creates.length, 1);
});

test('separate normal/Peek uploads and GUI attachments veto by metadata; completing one source never clears another', async () => {
  const { createAutomationDraftSource, createAutomationDraftPublisher } = await import('../src/stores/automation-draft-veto');
  const sessionId = 'session-attachments';
  const sent: { hasDraft: boolean; revision: number }[] = [];
  const publisher = createAutomationDraftPublisher(sessionId, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['hasDraft', 'revision', 'surfaceId']);
    sent.push(body);
    return Response.json({ ok: true });
  });
  const normal = createAutomationDraftSource(sessionId);
  const peek = createAutomationDraftSource(sessionId);
  const gui = createAutomationDraftSource(sessionId);
  const completeNormal = normal.hold();
  const completePeek = peek.hold();
  gui.setHasDraft(true);
  await publisher.flush();
  assert.equal(sent.at(-1)?.hasDraft, true);
  completeNormal();
  await publisher.flush();
  assert.equal(sent.at(-1)?.hasDraft, true);
  completePeek();
  await publisher.flush();
  assert.equal(sent.at(-1)?.hasDraft, true, 'GUI attachment remains protected after both uploads finish');
  gui.setHasDraft(false);
  await publisher.flush();
  assert.equal(sent.at(-1)?.hasDraft, false);
  assert.ok(sent.every((item, index) => index === 0 || item.revision > sent[index-1].revision));
});
