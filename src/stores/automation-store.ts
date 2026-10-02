import { v4 as uuid } from 'uuid';
import { createStore } from 'zustand/vanilla';
import type { Automation, AutomationInput, AutomationRun } from '@/lib/automation/contracts';
import { autorunPreviewSchema, decodeAutomation, automationSummaryV2Schema, autorunDecisionPageSchema, autorunDecisionDetailSchema, type AutomationV2, type AutomationInputV2, type AutomationSummaryV2, type AutorunPreview, type AutorunDecisionSummary, type AutorunDecisionDetail, type ControlResultV2 } from '@/lib/automation/autorun-contracts';
import { automationAttentionSchema, automationAttentionSummarySchema, type AutomationAttention } from '@/lib/automation/autorun-contracts';
import { getAutorunAttentionKey } from '@/lib/automation/client-state';
import { useNotificationStore } from './notification-store';
import { useAuthStore } from './auth-store';

export type AutomationScope = { sessionId: string } | { worktreeId: string };
export type AutomationHttp = typeof fetch;
type Page<T> = { items: T[]; nextCursor: string | null };
interface AutomationStore {
  items: AutomationSummaryV2[];
  details: Record<string, ControlResultV2>;
  preview: AutorunPreview | null;
  previewLoading: boolean;
  previewAutorun: (overrides?: unknown) => Promise<AutorunPreview | null>;
  newDecisionCount: Record<string, number>;
  showNewDecisions: (id: string) => void;
  decisions: Record<string, Page<AutorunDecisionSummary>>;
  loadDecisions: (id: string, more?: boolean) => Promise<void>;
  decisionDetails: Record<string, AutorunDecisionDetail>;
  inspectDecision: (id: string, decisionId: string) => Promise<void>;
  view: { selectedId: string | null; tab: 'overview' | 'history'; setup: boolean };
  drafts: Record<string, unknown>;
  runs: Record<string, Page<AutomationRun>>;
  loading: boolean;
  error: string | null;
  busy: number;
  lastControl: { status: number; body: ControlResultV2 } | null;
  inspect: (id: string) => Promise<ControlResultV2 | null>;
  refresh: () => Promise<void>;
  loadRuns: (id: string, more?: boolean) => Promise<void>;
  save: (input: AutomationInput | AutomationInputV2, previous?: Automation | AutomationV2) => Promise<boolean>;
  enable: (rule: Automation | AutomationV2) => Promise<boolean>;
  pause: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  resolve: (id: string, runId: string) => Promise<boolean>;
}

/** Target-scoped HTTP state. Only B updates the independent runtime ownership projection. */
export function createAutomationStore(scope: AutomationScope, http: AutomationHttp = fetch) {
  let listRequest = 0;
  let previewRequest = 0;
  const detailRequests = new Map<string, number>();
  const pendingDecisions = new Map<string, AutorunDecisionSummary[]>();
  const runPages = new Map<string, number>();
  const runRequests = new Map<string, number>();
  const keys = new Map<string, string>();
  const path = (id: string) => `/api/automations/${encodeURIComponent(id)}`;
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await http(url, { cache: 'no-store', ...init });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.code ?? 'RUNTIME_ADAPTER_UNAVAILABLE');
    if (!data) throw new Error('INVALID_RESPONSE');
    return data as T;
  }
  const errorCode = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message)
    ? error.message : 'NETWORK_ERROR';
  return createStore<AutomationStore>((set, get) => {
    async function mutate(url: string, method: string, body?: unknown, key?: string) {
      set({ busy: get().busy + 1, error: null });
      for (const [id, serial] of detailRequests) detailRequests.set(id, serial + 1);
      ++listRequest; // Invalidate pre-mutation reads.
      try {
        const response = await http(url, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.code ?? 'INVALID_RESPONSE');
        set({ lastControl: { status: response.status, body: data } });
        await get().refresh(); // Replayed creates may contain historical ownership/revisions.
        return true;
      } catch (error) {
        await get().refresh();
        set({ error: errorCode(error) });
        return false;
      } finally { set({ busy: get().busy - 1 }); }
    }
    return {
      items: [], details: {}, decisions: {}, newDecisionCount: {}, decisionDetails: {}, preview: null, previewLoading: false, view: { selectedId: null, tab: 'overview', setup: false }, drafts: {}, runs: {}, lastControl: null, loading: true, error: null, busy: 0,
      inspect: async (id) => {
        const serial = (detailRequests.get(id) ?? 0) + 1;
        detailRequests.set(id, serial);
        try {
          const data = await request<ControlResultV2>(path(id));
          const parsed = decodeAutomation(data.automation);
          if (!parsed.success || parsed.data.id !== id) throw new Error('INVALID_RESPONSE');
          if (serial !== detailRequests.get(id)) return null;
          const result = { ...data, automation: parsed.data };
          set({ details: { ...get().details, [id]: result } });
          return result;
        }
        catch (error) { if (serial === detailRequests.get(id)) set({ error: errorCode(error) }); return null; }
      },
      previewAutorun: async (overrides = {}) => {
        if (!('sessionId' in scope)) return null;
        const serial = ++previewRequest;
        set({ previewLoading: true, preview: null, error: null });
        try {
          const preview = autorunPreviewSchema.parse(await request(`/api/sessions/${encodeURIComponent(scope.sessionId)}/autorun-preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overrides),
          }));
          if (serial !== previewRequest) return null;
          if (preview.sessionId !== scope.sessionId) throw new Error('INVALID_RESPONSE');
          set({ preview, previewLoading: false });
          return preview;
        } catch (error) { if (serial === previewRequest) set({ previewLoading: false, error: errorCode(error) }); return null; }
      },
      showNewDecisions: id => {
        const pending = pendingDecisions.get(id);
        if (!pending) return;
        set({ decisions: { ...get().decisions, [id]: { ...get().decisions[id], items: pending } }, newDecisionCount: { ...get().newDecisionCount, [id]: 0 } });
        pendingDecisions.delete(id);
      },
      loadDecisions: async (id, more = false) => {
        const previous = get().decisions[id];
        if (more && !previous?.nextCursor) return;
        const key = `decisions:${id}`;
        const serial = (runRequests.get(key) ?? 0) + 1;
        runRequests.set(key, serial);
        const pagesToRead = more ? 1 : runPages.get(key) ?? 1;
        let cursor = more ? previous!.nextCursor : null;
        const items = more ? [...previous!.items] : [];
        let pagesRead = 0;
        try {
          do {
            const page = autorunDecisionPageSchema.parse(await request(`${path(id)}/decisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
            if (serial !== runRequests.get(key)) return;
            if (page.items.some(item => item.automationId !== id)) throw new Error('INVALID_RESPONSE');
            items.push(...page.items); cursor = page.nextCursor; pagesRead++;
          } while (cursor && pagesRead < pagesToRead);
          runPages.set(key, more ? (runPages.get(key) ?? 1) + 1 : pagesRead);
          const incoming = [...new Map([...items, ...(previous?.items.filter(old => !items.some(item => item.id === old.id)) ?? [])].map(item => [item.id, item])).values()];
          const newItems = previous && !more ? incoming.filter(item => !previous.items.some(old => old.id === item.id)) : [];
          if (newItems.length && previous) pendingDecisions.set(id, incoming);
          const shown = previous && !more ? previous.items.map(old => incoming.find(item => item.id === old.id) ?? old) : incoming;
          set({ decisions: { ...get().decisions, [id]: { items: shown, nextCursor: cursor } }, newDecisionCount: { ...get().newDecisionCount, [id]: newItems.length } });
        } catch (error) { if (serial === runRequests.get(key)) set({ error: errorCode(error) }); }
      },
      inspectDecision: async (id, decisionId) => {
        try {
          const detail = autorunDecisionDetailSchema.parse(await request(`${path(id)}/decisions/${encodeURIComponent(decisionId)}`));
          if (detail.id !== decisionId || detail.automationId !== id) throw new Error('INVALID_RESPONSE');
          set({ decisionDetails: { ...get().decisionDetails, [decisionId]: detail } });
        } catch (error) { set({ error: errorCode(error) }); }
      },
      refresh: async () => {
        const requestId = ++listRequest;
        try {
          const items: AutomationSummaryV2[] = [];
          let cursor: string | null = null;
          do {
            const query: URLSearchParams = new URLSearchParams({ ...scope, includeDeleted: 'true', limit: '100', ...(cursor ? { cursor } : {}) });
            const page = await request<Page<unknown>>(`/api/automations?${query}`);
            items.push(...page.items.map(toAutomationSummary));
            cursor = page.nextCursor;
          } while (cursor && requestId === listRequest);
          if (requestId === listRequest) {
            set({ items, loading: false });
            for (const item of items) if (item.attention) void receiveAutorunAttention(item.attention, http);
          }
        } catch (error) {
          if (requestId === listRequest) set({ loading: false, error: errorCode(error) });
        }
      },
      loadRuns: async (id, more = false) => {
        const previous = get().runs[id];
        if (more && !previous?.nextCursor) return;
        const requestId = (runRequests.get(id) ?? 0) + 1;
        runRequests.set(id, requestId);
        const pagesToRead = more ? 1 : runPages.get(id) ?? 1;
        let cursor = more ? previous.nextCursor : null;
        const items = more ? [...previous.items] : [];
        let pagesRead = 0;
        try {
          do {
            const page: Page<AutomationRun> = await request<Page<AutomationRun>>(`${path(id)}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
            if (requestId !== runRequests.get(id)) return;
            items.push(...page.items);
            cursor = page.nextCursor;
            pagesRead++;
          } while (cursor && pagesRead < pagesToRead);
          runPages.set(id, more ? (runPages.get(id) ?? 1) + 1 : pagesRead);
          set({ runs: { ...get().runs, [id]: { items: [...new Map(items.map(run => [run.id, run])).values()], nextCursor: cursor } } });
        } catch (error) { if (requestId === runRequests.get(id)) set({ error: errorCode(error) }); }
      },
      save: async (input, previous) => {
        if (previous) return mutate(path(previous.id), 'PUT', { expectedRevision: previous.revision, input: { ...input, enabled: false } });
        const body = JSON.stringify(input);
        const key = keys.get(body) ?? uuid(); // uuid supports HTTP without crypto.randomUUID.
        keys.set(body, key);
        const saved = await mutate('/api/automations', 'POST', input, key);
        if (saved) keys.delete(body);
        return saved;
      },
      enable: (rule) => mutate(`${path(rule.id)}/state`, 'POST', { action: 'enable', expectedRevision: rule.revision }),
      pause: (id) => mutate(`${path(id)}/state`, 'POST', { action: 'pause' }),
      remove: (id) => mutate(path(id), 'DELETE'),
      resolve: async (id, runId) => {
        const resolved = await mutate(`${path(id)}/runs/${encodeURIComponent(runId)}/resolve`, 'POST', { resolution: 'acknowledge-no-retry' });
        await get().loadRuns(id);
        return resolved;
      },
    };
  });
}
export type AutomationStoreApi = ReturnType<typeof createAutomationStore>;

function toAutomationSummary(value: unknown): AutomationSummaryV2 {
  const summary = automationSummaryV2Schema.safeParse(value);
  if (summary.success) return summary.data;
  const decoded = decodeAutomation(value);
  if (!decoded.success) throw new Error('INVALID_RESPONSE');
  const rule = decoded.data;
  return { version: 2, id: rule.id, name: rule.name, revision: rule.revision, mode: rule.mode,
    state: rule.state, pauseReason: rule.pauseReason, sessionId: rule.target.kind === 'wake-session' ? rule.target.sessionId : null,
    worktreeId: rule.target.kind === 'create-session' ? rule.target.worktreeId : null, nextDueAt: rule.nextDueAt,
    dispatchCount: rule.dispatchCount, analysisCount: rule.mode === 'autorun' ? rule.analysisCount : 0,
    latestDecisionId: rule.mode === 'autorun' ? rule.latestDecisionId : null,
    attention: rule.mode === 'autorun' ? rule.attention?.identity ?? null : null };
}

const scopedStores = new Map<string, { store: AutomationStoreApi; subscribers: number; stop?: () => void }>();
export function getAutomationStore(ownerId: string, scope: AutomationScope) {
  const key = `${ownerId}:${'sessionId' in scope ? 'session:'+scope.sessionId : 'worktree:'+scope.worktreeId}`;
  let entry = scopedStores.get(key);
  if (!entry) { entry = { store: createAutomationStore(scope), subscribers: 0 }; scopedStores.set(key, entry); }
  return entry;
}
export function subscribeAutomationScope(ownerId: string, scope: AutomationScope) {
  const entry = getAutomationStore(ownerId, scope);
  if (entry.subscribers++ === 0) {
    const refresh = () => void entry.store.getState().refresh();
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    entry.stop = () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }
  return () => { if (--entry.subscribers === 0) { entry.stop?.(); entry.stop = undefined; } };
}
export function invalidateAutomationStores(automationId?: string) {
  const owner = useAuthStore.getState().user?.id;
  for (const [key, entry] of scopedStores) {
    if (!owner || !key.startsWith(`${owner}:`) || !entry.subscribers) continue;
    void entry.store.getState().refresh();
    const selected = entry.store.getState().view.selectedId;
    if (selected && (!automationId || selected === automationId)) void entry.store.getState().inspect(selected);
  }
}
useAuthStore.subscribe((state, previous) => {
  if (state.user?.id === previous.user?.id) return;
  for (const entry of scopedStores.values()) entry.stop?.();
  scopedStores.clear();
  useNotificationStore.setState(state => ({ notifications: state.notifications.filter(n => !('attention' in n)) }));
  automationAttentionNavigation.setState({ target: null });
});

const attentionRequests = new Set<string>();
export async function receiveAutorunAttention(value: unknown, http: AutomationHttp = fetch) {
  const parsed = automationAttentionSchema.safeParse(value);
  const ownerId = useAuthStore.getState().user?.id;
  if (!parsed.success || !ownerId) return;
  const identity = parsed.data;
  const key = getAutorunAttentionKey(identity);
  const pendingKey = `${ownerId}:${key}`;
  if (attentionRequests.has(pendingKey)) return;
  attentionRequests.add(pendingKey);
  try {
    const response = await http(`/api/automations/${encodeURIComponent(identity.automationId)}`, { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (useAuthStore.getState().user?.id !== ownerId) return;
    const rule = decodeAutomation(result.automation);
    if (!rule.success || rule.data.mode !== 'autorun' || rule.data.ownerUserId !== ownerId) return;
    const summary = automationAttentionSummarySchema.safeParse(rule.data.attention);
    if (!summary.success || getAutorunAttentionKey(summary.data.identity) !== key) return;
    publishAutorunAttention(summary.data.identity, summary.data.summary);
  } catch { /* Read-only attention recovery retries on the next reconciliation. */ }
  finally { attentionRequests.delete(pendingKey); }
}
function publishAutorunAttention(attention: AutomationAttention, summary: string) {
  useNotificationStore.getState().addNotification({ sessionId: attention.sessionId,
    type: attention.outcome === 'complete' ? 'autorun_complete' : 'autorun_attention', attention,
    preview: summary, dedupKey: getAutorunAttentionKey(attention) });
}
export const automationAttentionNavigation = createStore<{ target: AutomationAttention | null }>(() => ({ target: null }));
export function openAutomationAttention(attention: AutomationAttention) { automationAttentionNavigation.setState({ target: attention }); }

/** Reconcile only each rule's latest persisted attention, including workers with no mounted view. */
export async function reconcileAutorunAttention(http: AutomationHttp = fetch) {
  const ownerId = useAuthStore.getState().user?.id;
  if (!ownerId) return;
  let cursor: string | null = null;
  try {
    do {
      const query: URLSearchParams = new URLSearchParams({ includeDeleted: 'true', limit: '100', ...(cursor ? { cursor } : {}) });
      const response = await http(`/api/automations?${query}`, { cache: 'no-store' });
      if (!response.ok) return;
      const page: Page<unknown> = await response.json();
      if (useAuthStore.getState().user?.id !== ownerId) return;
      for (const value of page.items) {
        const item = toAutomationSummary(value);
        if (item.attention) await receiveAutorunAttention(item.attention,http);
      }
      cursor = page.nextCursor;
    } while (cursor);
  } catch { /* Reconnect and normal scoped reconciliation may retry this read. */ }
}
