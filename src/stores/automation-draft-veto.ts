import type { AutomationDraftVeto } from '@/lib/automation/activation-contracts';
import { getClientId } from '@/lib/ws/client-id';
import { useChatStore } from './chat-store';

// Revisions survive mounted-surface and auth-store cache turnover in this renderer.
const revisions = new Map<string, number>();
type DraftSource = { kind: string; attached: boolean; held: number; hasDraft: boolean };
const localSources = new Map<string, Map<DraftSource, boolean>>();
const localChanges = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
/** A pending upload/local attachment contributes only presence, never its content. */
export function createAutomationDraftSource(sessionId: string, kind = 'local') {
  const sources = localSources.get(sessionId) ?? new Map<DraftSource, boolean>();
  // Reclaim a disconnected source of this kind; other mounted surfaces keep their own record.
  const source = [...sources.keys()].find(item => item.kind === kind && !item.attached)
    ?? { kind, attached: true, held: 0, hasDraft: false };
  source.attached = true;
  if (!sources.has(source)) sources.set(source, false);
  localSources.set(sessionId, sources);
  const update = () => {
    const present = source.hasDraft || source.held > 0;
    if (sources.get(source) === present) return;
    sources.set(source, present);
    localChanges.set(sessionId, (localChanges.get(sessionId) ?? 0) + 1);
    for (const listener of listeners.get(sessionId) ?? []) listener();
  };
  return {
    connect: () => { source.attached = true; return () => { source.attached = false; }; },
    setHasDraft: (present: boolean) => { source.hasDraft = present; update(); },
    hold: () => {
      source.held++; update();
      let released = false;
      return () => { if (!released) { released = true; source.held--; update(); } };
    },
  };
}
const hasLocalDraft = (sessionId: string) => [...(localSources.get(sessionId)?.values() ?? [])].some(Boolean);
/** Normal and Peek share one retained ChatStore draft, hence one canonical veto source. */
export function createAutomationDraftPublisher(sessionId: string, http: typeof fetch) {
  let text: string | undefined;
  let localRevision = -1;
  let pending: Promise<void> | null = null;
  let acknowledged = false;
  function publish() {
    const current = useChatStore.getState().getDraftInput(sessionId);
    const local = localChanges.get(sessionId) ?? 0;
    if (text === current && localRevision === local && pending) return pending;
    if (text === current && localRevision === local && acknowledged) return Promise.resolve();
    text = current;
    localRevision = local;
    acknowledged = false;
    const revision = (revisions.get(sessionId) ?? 0) + 1;
    revisions.set(sessionId, revision);
    const body: AutomationDraftVeto = { surfaceId: `composer:${getClientId()}`, revision, hasDraft: current.length > 0 || hasLocalDraft(sessionId) };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('NETWORK_ERROR')); abort.abort(); }, 10_000);
    });
    let request!: Promise<void>;
    request = (async () => {
      try {
        const response = await Promise.race([http(`/api/sessions/${encodeURIComponent(sessionId)}/automation-input`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal,
        }), timeout]);
        if (!response.ok) throw new Error('NETWORK_ERROR');
        if (pending === request) acknowledged = true;
      } finally {
        clearTimeout(timer!);
        if (pending === request) pending = null;
      }
    })();
    pending = request;
    return request;
  }
  return {
    watch: () => {
      void publish().catch(() => {}); // A failed publication is retried by flush before enable.
      const onLocalChange = () => void publish().catch(() => {});
      const local = listeners.get(sessionId) ?? new Set<() => void>();
      local.add(onLocalChange); listeners.set(sessionId, local);
      const stop = useChatStore.subscribe((state, previous) => {
        if (state.draftInputs.get(sessionId) !== previous.draftInputs.get(sessionId)) onLocalChange();
      });
      return () => { stop(); local.delete(onLocalChange); }; // Disconnect never clears a draft.
    },
    flush: async () => {
      do { await publish(); } while (!acknowledged || text !== useChatStore.getState().getDraftInput(sessionId) || localRevision !== (localChanges.get(sessionId) ?? 0));
    },
  };
}
