// Synthetic HTTP/runtime events only; renders the actual shared manager.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationManager } from '../../src/components/automation/automation-manager';
import { createAutomationStore } from '../../src/stores/automation-store';
import { applySessionInputOwnership } from '../../src/lib/automation/client-state';
import { automationFixture, automationNow, ownershipFixture, runFixture } from './automation';
Date.now = () => automationNow;
const query = new URLSearchParams(location.search);
let rule = { ...automationFixture(), state: 'paused' as 'paused' | 'deleted', name: 'Retained review', dispatchCount: 2 };
let ownership = { ...ownershipFixture(), mode: 'human' as 'human' | 'draining', automationId: null as string | null };
applySessionInputOwnership(ownership);
const calls: string[] = [];
const store = createAutomationStore({ sessionId: 'session-1' }, async (url, init) => {
  const path = String(url);
  if (init?.method && !path.endsWith('autorun-preview')) calls.push(`${init.method} ${path}`);
  if (path.endsWith('autorun-preview')) return Response.json({ error: { code: 'CONTEXT_UNAVAILABLE' } }, { status: 409 });
  if (init?.method === 'DELETE') {
    if (query.has('reject-delete')) return Response.json({ error: { code: 'REVISION_CONFLICT' } }, { status: 409 });
    if (query.has('delay-delete')) await new Promise(resolve => setTimeout(resolve, 600));
    rule = { ...rule, state: 'deleted' };
    // Separate authoritative runtime fixture event, never a UI-derived unlock.
    ownership = { ...ownership, mode: 'draining', automationId: rule.id };
    applySessionInputOwnership(ownership);
    return Response.json({ automation: rule, inputOwnership: ownership, inFlightRunId: 'writer-drain' }, { status: 202 });
  }
  if (path.includes('/runs')) return Response.json({ items: [{ ...runFixture(), state: 'delivered', sessionId: null }], nextCursor: null });
  if (path === `/api/automations/${rule.id}`) return Response.json({ automation: rule, inputOwnership: ownership, inFlightRunId: ownership.mode === 'draining' ? 'writer-drain' : null });
  return Response.json({ items: [rule], nextCursor: null });
});
await store.getState().refresh();
function Fixture() {
  const [open, setOpen] = useState(true);
  const [_, update] = useState(0);
  return <><div data-automation-navigation-fixture="synthetic"><p>FAKE transport/runtime · real shared React manager · no provider/PTY</p><textarea aria-label="Worker draft" defaultValue="Retained worker draft" /><button onClick={() => setOpen(true)}>Open fixture manager</button><button onClick={() => update(n => n + 1)}>Inspect fixture writes</button><output aria-label="Fixture writes">{calls.join('\n')}</output></div>{open && <AutomationManager scope={{sessionId:'session-1'}} store={store} onClose={() => setOpen(false)} onOpenSession={() => {}} />}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
