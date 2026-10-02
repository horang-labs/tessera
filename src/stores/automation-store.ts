import { v4 as uuid } from 'uuid';
import { createStore } from 'zustand/vanilla';
import type { Automation, AutomationInput, AutomationRun, ControlResult } from '@/lib/automation/contracts';

export type AutomationScope = { sessionId: string } | { worktreeId: string };
export type AutomationHttp = typeof fetch;
type Page<T> = { items: T[]; nextCursor: string | null };
interface AutomationStore {
  items: Automation[];
  runs: Record<string, Page<AutomationRun>>;
  loading: boolean;
  error: string | null;
  busy: number;
  inspect: (id: string) => Promise<ControlResult | null>;
  refresh: () => Promise<void>;
  loadRuns: (id: string, more?: boolean) => Promise<void>;
  save: (input: AutomationInput, previous?: Automation) => Promise<boolean>;
  enable: (rule: Automation) => Promise<boolean>;
  pause: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  resolve: (id: string, runId: string) => Promise<boolean>;
}

/** Target-scoped HTTP state. Only B updates the independent runtime ownership projection. */
export function createAutomationStore(scope: AutomationScope, http: AutomationHttp = fetch) {
  let listRequest = 0;
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
      ++listRequest; // Invalidate pre-mutation reads.
      try {
        await request(url, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        await get().refresh(); // Replayed creates may contain historical ownership/revisions.
        return true;
      } catch (error) {
        await get().refresh();
        set({ error: errorCode(error) });
        return false;
      } finally { set({ busy: get().busy - 1 }); }
    }
    return {
      items: [], runs: {}, loading: true, error: null, busy: 0,
      inspect: async (id) => {
        try { return await request<ControlResult>(path(id)); }
        catch (error) { set({ error: errorCode(error) }); return null; }
      },
      refresh: async () => {
        const requestId = ++listRequest;
        try {
          const items: Automation[] = [];
          let cursor: string | null = null;
          do {
            const query: URLSearchParams = new URLSearchParams({ ...scope, includeDeleted: 'true', limit: '100', ...(cursor ? { cursor } : {}) });
            const page: Page<Automation> = await request<Page<Automation>>(`/api/automations?${query}`);
            items.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor && requestId === listRequest);
          if (requestId === listRequest) set({ items, loading: false });
        } catch (error) {
          if (requestId === listRequest) set({ loading: false, error: errorCode(error) });
        }
      },
      loadRuns: async (id, more = false) => {
        const requestId = (runRequests.get(id) ?? 0) + 1;
        runRequests.set(id, requestId);
        const previous = get().runs[id];
        const cursor = more ? previous?.nextCursor : null;
        try {
          const page = await request<Page<AutomationRun>>(`${path(id)}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
          if (requestId !== runRequests.get(id)) return;
          set({ runs: { ...get().runs, [id]: { ...page, items: more ? [...(previous?.items ?? []), ...page.items] : page.items } } });
        } catch (error) { set({ error: errorCode(error) }); }
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
