import assert from 'node:assert/strict';
import test from 'node:test';
import { useNotificationStore } from '../src/stores/notification-store';

test('Autorun attention and native approval coexist, and replay or dismissal never repeats attention', () => {
  const store = useNotificationStore;
  store.setState({ notifications: [] });
  const attention = { kind: 'rule' as const, automationId: 'rule-1', revision: 2, sessionId: 'session-1', decisionId: null, outcome: 'error' as const, reason: 'CONTEXT_UNAVAILABLE' as const };
  store.getState().addNotification({ sessionId: 'session-1', type: 'permission_request', preview: 'Native approval' });
  const item = { sessionId: 'session-1', type: 'autorun_attention' as const, attention, preview: 'Latest context unavailable', dedupKey: 'autorun:rule-1:2:CONTEXT_UNAVAILABLE' };
  assert.equal(store.getState().addNotification(item), true);
  assert.equal(store.getState().notifications.filter(n => !n.dismissed).length, 2);
  assert.equal(store.getState().addNotification(item), false);
  store.getState().dismissNotification(store.getState().notifications[0].id);
  assert.equal(store.getState().addNotification(item), false);
});

test('text-free attention fetches owner-only summary, deduplicates and clears private state on owner change', async () => {
  const { receiveAutorunAttention, openAutomationAttention, automationAttentionNavigation } = await import('../src/stores/automation-store');
  const { useAuthStore } = await import('../src/stores/auth-store');
  const { autorunInput } = await import('./fixtures/autorun-contracts');
  const { automationFixture } = await import('./fixtures/automation');
  const identity = { kind:'rule' as const, automationId:'rule-1',revision:9,sessionId:'session-1',decisionId:null,outcome:'error' as const,reason:'CONTEXT_UNAVAILABLE' as const };
  const { prompt: _prompt,...base } = automationFixture(); void _prompt;
  const { enabled: _enabled,...input } = autorunInput(); void _enabled;
  const rule = { ...base,...input,revision:9,ownerUserId:'owner-1',autorun:{...input.autorun,objective:{kind:'explicit',text:'Private saved goal',revision:1},criterionOrigin:'explicit'},analysisCount:1,latestDecisionId:null,autorunStatus:'error',attention:{identity,summary:'Private owner-only explanation',createdAt:1800000000000} };
  useAuthStore.setState({user:{id:'owner-1',username:'Owner'}});
  useNotificationStore.setState({notifications:[]});
  const http: typeof fetch = async()=>Response.json({automation:rule,inputOwnership:null,inFlightRunId:null});
  await receiveAutorunAttention(identity,http); await receiveAutorunAttention(identity,http);
  assert.equal(useNotificationStore.getState().notifications.length,1);
  assert.equal(useNotificationStore.getState().notifications[0].preview,'Private owner-only explanation');
  openAutomationAttention(identity);
  useAuthStore.setState({user:{id:'other-owner',username:'Other'}});
  assert.equal(useNotificationStore.getState().notifications.length,0);
  assert.equal(automationAttentionNavigation.getState().target,null);
  await receiveAutorunAttention(identity,http);
  assert.equal(useNotificationStore.getState().notifications.length,0);
});
