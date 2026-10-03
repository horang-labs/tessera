// Real shared manager/forms; synthetic HTTP/ownership only. Never a provider/PTY proof.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationManager } from '../../src/components/automation/automation-manager';
import { createAutomationStore } from '../../src/stores/automation-store';
import { useSessionStore } from '../../src/stores/session-store';
import { applySessionInputOwnership } from '../../src/lib/automation/client-state';
import { i18n } from '../../src/lib/i18n';
import { autorunPreviewFixture } from './autorun-contracts';
import { automationNow, ownershipFixture } from './automation';
import type { ProjectGroup } from '../../src/types/chat';
const query = new URLSearchParams(location.search);
Date.now = () => automationNow;
await i18n.changeLanguage(query.get('language') ?? 'en');
document.documentElement.classList.toggle('dark', query.get('theme') !== 'light');
const project: ProjectGroup = { encodedDir: 'tessera-dev', displayName: 'Tessera', decodedPath: '/fixture', isCurrent: true,
  sessions: [{ id: 'session-1', title: 'Fix login · 로그인 오류 수정', projectDir: 'tessera-dev', originProjectId: 'tessera-dev',
    isRunning: true, status: 'completed', lastModified: 'fixture', createdAt: 'fixture', worktreeBranch: 'feature/login' }],
  totalSessions: 1, allLoaded: true, loadedCount: 1, nextCursor: null, loadBatchIndex: 0,
  projectWorktree: { path: '/fixture', id: 'wt-1', currentBranch: 'feature/login', displayPath: '/fixture' } };
useSessionStore.setState({ projects: [project] });
const preview = { ...autorunPreviewFixture(), objective: { kind: 'explicit', text: 'Fix the login error and verify the regression.\n로그인 오류를 수정하고 회귀 테스트를 확인해 주세요.', revision: 1 } };
if (query.has('idle')) preview.readiness = { kind: 'idle', reason: 'consumed-boundary' } as typeof preview.readiness;
const scope = query.has('schedule') ? { worktreeId: 'wt-1' } : { sessionId: 'session-1' };
const ownership = { ...ownershipFixture(), mode: 'human' as const, automationId: null };
applySessionInputOwnership(ownership);
const writes: unknown[] = [];
const nativeFetch = window.fetch;
window.fetch = async (url, init) => String(url).startsWith('/api/providers/session-options')
  ? Response.json({ modelOptions: [{ value: 'fixture-model', label: 'Fixture model', isDefault: true, defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [{ value: 'high', label: 'High' }], serviceTiers: [] }] }) : nativeFetch(url, init);
const store = createAutomationStore(scope, async (url, init) => {
  const path = String(url);
  if (path.endsWith('autorun-preview')) return query.has('preview-error') ? Response.json({ error: { code: 'STALE_CONTEXT' } }, { status: 409 }) : Response.json(preview);
  if (init?.method && init.method !== 'GET') {
    writes.push({ method: init.method, path, body: JSON.parse(String(init.body ?? '{}')) });
    return Response.json({ error: { code: 'REVISION_CONFLICT' } }, { status: 409 });
  }
  return Response.json({ items: [], nextCursor: null });
});
await store.getState().refresh();
function Fixture() {
  const [open, setOpen] = useState(false);
  const [_, update] = useState(0);
  return <main data-automation-polish-fixture="synthetic" className="p-4 text-sm text-(--text-primary)">
    <p>FAKE transport/runtime · shared React UI · no provider/PTY</p>
    <button onClick={() => setOpen(true)}>Open fixture manager</button>
    <button onClick={() => update(n => n+1)}>Inspect fixture writes</button>
    <output aria-label="Fixture writes">{JSON.stringify(writes)}</output>
    {open && <AutomationManager scope={scope} store={store} onClose={() => setOpen(false)} onOpenSession={() => setOpen(false)} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
