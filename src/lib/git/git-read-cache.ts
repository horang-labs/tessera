import path from 'node:path';
import type { AgentEnvironment } from '@/lib/settings/types';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

interface State {
  generation: number;
  mutations: number;
  panelGeneration: number;
}
const GLOBAL_KEY = Symbol.for('tessera.gitReadGeneration');
const globalState = globalThis as unknown as { [GLOBAL_KEY]?: State };
const state = globalState[GLOBAL_KEY] ??= { generation: 0, mutations: 0, panelGeneration: 0 };

export function invalidateGitPanelReads(): void {
  state.panelGeneration++;
}

export function getGitPanelReadGeneration(): number {
  return state.generation + state.panelGeneration;
}

export function getGitReadGeneration(): number {
  return state.generation;
}

/** Conservative across linked worktrees: fetch/config can affect sibling trees. */
export function invalidateGitReads(): void {
  state.generation++;
}

export function beginGitMutation(): () => void {
  state.mutations++;
  invalidateGitReads();
  return () => {
    state.mutations--;
    invalidateGitReads();
  };
}

export function gitReadKey(
  workDir: string,
  agentEnvironment: AgentEnvironment,
  userId: string | undefined,
  query: string,
  options: readonly unknown[] = [],
): string {
  // Preserve WSL distro and case. Collapsing UNC to /home loses the distro;
  // trimming a POSIX path would alias a valid checkout with trailing spaces.
  const normalized = normalizeGitReadPath(workDir);
  return JSON.stringify([userId ?? null, agentEnvironment, getRuntimePlatform(), normalized, query, options]);
}

/** Lexical normalization only: aliases need proven filesystem identity. */
export function normalizeGitReadPath(workDir: string): string {
  const windowsPath = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(workDir);
  return (windowsPath ? path.win32 : path.posix).resolve(workDir);
}

/** Used by the existing panel cache; failures never become result entries. */
export class GitReadCache<T> {
  private entries = new Map<string, Entry<T>>();
  private generation = getGitPanelReadGeneration();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 256) {}

  read(key: string, compute: () => Promise<T>): Promise<T> {
    if (this.generation !== getGitPanelReadGeneration()) {
      this.entries.clear();
      this.generation = getGitPanelReadGeneration();
    }
    // A read during a mutation may observe intermediate state. Never share it
    // with a later request, including one arriving before the mutation ends.
    if (state.mutations) return compute();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    const entry: Entry<T> = { promise: Promise.resolve().then(compute), expiresAt: Infinity };
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, entry);
    entry.promise = entry.promise.then((value) => {
      entry.expiresAt = Date.now() + this.ttlMs;
      return value;
    }, (error: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return entry.promise;
  }
}
