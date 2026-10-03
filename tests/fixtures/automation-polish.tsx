// Real shared manager/forms; synthetic HTTP/ownership only. Never a provider/PTY proof.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Header } from '../../src/components/chat/header';
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
    kind: 'terminal', provider: 'codex', isRunning: true, status: 'completed', lastModified: 'fixture', createdAt: 'fixture', worktreeBranch: 'feature/login' }],
  totalSessions: 1, allLoaded: true, loadedCount: 1, nextCursor: null, loadBatchIndex: 0,
  projectWorktree: { path: '/fixture', id: 'wt-1', currentBranch: 'feature/login', displayPath: '/fixture' } };
useSessionStore.setState({ projects: [project] });
const preview = { ...autorunPreviewFixture(), objective: { kind: 'verified-human', text: 'Fix the login error and verify the regression.', revision: 1, sources: [{ messageId: 'message-1', recordId: 'record-1', excerpt: 'Fix the login error and verify the regression.', textHash: 'd'.repeat(64), origin: 'tessera-human-correlated' }] }, supervisorDiscovery: { candidates: [
  ...autorunPreviewFixture().supervisorDiscovery.candidates,
  { provider: 'codex', model: 'gpt-6-astra', label: 'GPT-6-Astra', reasoningEfforts: ['low','medium','high','xhigh'], serviceTiers: ['default','fast'], source: 'native', unavailableReason: null },
  { provider: 'claude-code', model: 'claude-opus-4-6', label: 'Claude Opus 4.6', reasoningEfforts: ['low','medium','high'], serviceTiers: [null], source: 'curated', unavailableReason: null },
], complete: true } };
if (query.has('idle')) preview.readiness = { kind: 'idle', reason: 'consumed-boundary' } as typeof preview.readiness;
const scope = query.has('schedule') ? { worktreeId: 'wt-1' } : { sessionId: 'session-1' };
const ownership = query.has('held') ? { ...ownershipFixture(), mode: 'draining' as const } : { ...ownershipFixture(), mode: 'human' as const, automationId: null };
applySessionInputOwnership(ownership);
const writes: unknown[] = [];
const fixtureHttp: typeof fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/api/providers/session-options')) return Response.json({ modelOptions: [{ value: 'fixture-model', label: 'Fixture model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ value: 'high', label: 'High' }], serviceTiers: [] }] });
  if (path.endsWith('autorun-preview')) {
    if (query.has('loading')) await new Promise(resolve => setTimeout(resolve, 60000));
    if (query.has('preview-error')) return Response.json({ error: { code: 'STALE_CONTEXT' } }, { status: 409 });
    const requested = JSON.parse(String(init?.body ?? '{}')).supervisor;
    if (requested) return Response.json({ ...preview, supervisorCheck: { selection: requested, status: query.has('unsupported') ? 'unavailable' : 'available', reason: query.has('unsupported') ? 'selection' : null },
      supervisorOptions: query.has('unsupported') ? [] : [{ ...preview.supervisorOptions[0], selection: requested }], recommendedSupervisor: query.has('unsupported') || requested.serviceTier === 'fast' ? null : requested });
    return Response.json(preview);
  }
  if (init?.method && init.method !== 'GET') {
    writes.push({ method: init.method, path, body: JSON.parse(String(init.body ?? '{}')) });
    return Response.json({ error: { code: 'REVISION_CONFLICT' } }, { status: 409 });
  }
  return Response.json({ items: [], nextCursor: null });
};
window.fetch = fixtureHttp;
const store = createAutomationStore(scope, fixtureHttp);
await store.getState().refresh();
function Fixture() {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [_, update] = useState(0);
  return <main data-automation-polish-fixture="synthetic" className="p-4 text-sm text-(--text-primary)">
    {!query.has('schedule') && <section aria-label="Shared Session toolbar" className="mb-4 border border-(--divider)"><Header sessionId="session-1" panelId="fixture-panel" isSinglePanel peek={query.has('peek') ? { onClose: () => {}, closeButtonRef } : undefined} /></section>}
    <p>FAKE transport/runtime · shared React UI · no provider/PTY</p>
    <button onClick={() => setOpen(true)}>Open fixture manager</button>
    <button onClick={() => update(n => n+1)}>Inspect fixture writes</button>
    <output aria-label="Fixture writes">{JSON.stringify(writes)}</output>
    {open && <AutomationManager scope={scope} store={store} onClose={() => setOpen(false)} onOpenSession={() => setOpen(false)} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
