import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import { evidenceHash } from './autorun-context';
import { readHumanSubmissions } from './autorun-human-evidence';
import type { AutorunHookEvidence } from './autorun-contracts';
import type { RuntimeObservation } from './runtime-port';

type Scope = { userId: string; sessionId: string; agentEnvironment: 'native' | 'wsl' };
type Source = { canonicalPath: string; sourceIdentityHash: string; fileGeneration: string; providerConversationId: string; nativeId: string };
type Intent = { version: 1; scope: Scope; runtime: Pick<RuntimeObservation, 'serverInstanceId' | 'generation' | 'terminalId'> | null;
  source: Source | null; cursor: number | null; anchor: string | null; fresh: boolean; submitted: boolean; noWrite?: boolean;
  seenNativeIds: string[]; nativeId?: string };
function directory(scope: Scope) { return getTesseraDataPath('autorun-origin', evidenceHash(JSON.stringify([scope.userId, scope.sessionId, scope.agentEnvironment]))); }
async function read<T>(file: string): Promise<T | null> {
  try { if ((await fs.stat(file)).size > 32_768) throw Error('Origin metadata bound'); return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
/** Durable origin files and native reads never run inside a SQLite writer transaction. */
async function persist(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID(), handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}
async function checkGeneration(source: Source, serverPath: string) {
  const file = path.join(path.dirname(serverPath), '.tessera-autorun', source.sourceIdentityHash + '.generation.json');
  return (await read<{ id: string }>(file))?.id === source.fileGeneration;
}
const pendingSettlements = new Map<string, Promise<void>>();
export async function prepareAutomationOrigin(args: Scope & { runId: string; runtime?: Intent['runtime']; fresh?: boolean }) {
  const scope: Scope = { userId: args.userId, sessionId: args.sessionId, agentEnvironment: args.agentEnvironment };
  const dir = directory(scope), file = path.join(dir, evidenceHash(JSON.stringify([args.runId, args.runtime?.serverInstanceId ?? null])) + '.intent.json');
  const cancelledFile = path.join(dir, 'cancelled', path.basename(file));
  if (await read<Intent>(file) || await read<Intent>(cancelledFile)) throw Error('Origin write already attempted');
  const source = args.fresh ? null : await read<Source>(path.join(dir, 'source.json'));
  let cursor: number | null = null, anchor: string | null = null;
  if (source) {
    const serverPath = await resolveAgentReportedPath(source.canonicalPath, scope.agentEnvironment);
    if (!await checkGeneration(source, serverPath)) throw Error('Origin source changed');
    const handle = await fs.open(serverPath, 'r');
    try {
      const size = (await handle.stat()).size, bytes = Buffer.alloc(Math.min(size, 4096));
      if ((await handle.read(bytes, 0, bytes.length, size - bytes.length)).bytesRead !== bytes.length || size && bytes.at(-1) !== 10) throw Error('Origin cursor incomplete');
      cursor = size; anchor = evidenceHash(bytes);
    } finally { await handle.close(); }
  }
  const receipts = await readHumanSubmissions(scope.userId, scope.sessionId);
  const seenNativeIds = source ? [...new Set([source.nativeId, ...(receipts ?? []).filter(r => r.sourceIdentityHash === source.sourceIdentityHash && r.fileGeneration === source.fileGeneration).map(r => r.nativeId)])].filter(Boolean) : [];
  const intent: Intent = { version: 1, scope, runtime: args.runtime ?? null, source, cursor, anchor, fresh: args.fresh === true, submitted: false, seenNativeIds };
  await persist(file, intent);
  let settlement: Promise<void> | undefined;
  const flush = () => {
    if (settlement) return settlement;
    const pending = settlement = persist(file, intent);
    pendingSettlements.set(file, pending);
    void pending.finally(() => { if (pendingSettlements.get(file) === pending) pendingSettlements.delete(file); }).catch(() => {});
    return pending;
  };
  return {
    // Inside the write fence: memory only. Receipts wait for the later async disk settlement.
    submitted() { intent.submitted = true; }, flush,
    async cancelled() {
      intent.noWrite = true; await flush();
      await fs.mkdir(path.dirname(cancelledFile), { recursive: true, mode: 0o700 });
      await fs.rename(file, cancelledFile);
    },
  };
}
/** Native IDs, never prompt text, join a host write to the first previously unobserved lead turn. */
function firstNativeId(bytes: Buffer, provider: 'codex' | 'claude-code', conversation: string, seen: string[]): string | null {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text && !text.endsWith('\n')) throw Error('Incomplete native origin');
  for (const line of text.split('\n').filter(Boolean)) {
    if (Buffer.byteLength(line) > 1024 * 1024) throw Error('Native origin record bound');
    const r = JSON.parse(line);
    if (provider === 'codex' && r.type === 'event_msg' && r.payload?.type === 'task_started' && typeof r.payload.turn_id === 'string' && !seen.includes(r.payload.turn_id)) return r.payload.turn_id;
    if (provider === 'claude-code' && r.type === 'user' && r.sessionId === conversation && typeof r.promptId === 'string' && !r.isSidechain && !r.isMeta && !r.isSynthetic && !r.isCompactSummary && !seen.includes(r.promptId)) return r.promptId;
  }
  return null;
}
export async function submissionOrigin(args: { event: Extract<AutorunHookEvidence, { kind: 'submission' }>; canonicalPath: string; humanOrigin: boolean }): Promise<'human' | 'automation' | 'unknown'> {
  const { event } = args, e = event.evidence;
  const scope: Scope = { userId: event.userId, sessionId: event.sessionId, agentEnvironment: event.agentEnvironment };
  const nativeId = e.provider === 'codex' ? e.nativeTurnId : e.nativePromptId;
  const source: Source = { canonicalPath: args.canonicalPath, sourceIdentityHash: e.sourceIdentityHash, fileGeneration: e.fileGeneration, providerConversationId: e.providerConversationId, nativeId };
  if (!args.canonicalPath || evidenceHash(args.canonicalPath) !== e.sourceIdentityHash) return 'unknown';
  try {
    const serverPath = await resolveAgentReportedPath(source.canonicalPath, scope.agentEnvironment);
    if (!await checkGeneration(source, serverPath)) return 'unknown';
    const dir = directory(scope);
    await Promise.all([...pendingSettlements].filter(([file]) => path.dirname(file) === dir).map(([, pending]) => pending));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const files = (await fs.readdir(dir)).filter(n => n.endsWith('.intent.json'));
    if (files.length > 100) return 'unknown';
    let automatic = false, unknown = false;
    for (const name of files) {
      const file = path.join(dir, name), intent = await read<Intent>(file);
      if (!intent || intent.version !== 1 || JSON.stringify(intent.scope) !== JSON.stringify(scope)) return 'unknown';
      if (intent.noWrite) continue;
      if (intent.source && (intent.source.sourceIdentityHash !== e.sourceIdentityHash || intent.source.fileGeneration !== e.fileGeneration || intent.source.providerConversationId !== e.providerConversationId)) {
        if (!intent.nativeId) unknown = true;
        continue;
      }
      if (intent.nativeId) { if (intent.nativeId === nativeId) automatic = true; continue; }
      if (intent.seenNativeIds?.includes(nativeId)) continue;
      if (!intent.submitted || !Array.isArray(intent.seenNativeIds) || !intent.fresh && intent.cursor === null) { unknown = true; continue; }
      if (intent.runtime && (intent.runtime.serverInstanceId !== e.serverInstanceId || intent.runtime.generation !== e.terminalGeneration || intent.runtime.terminalId !== event.terminalId)) { unknown = true; continue; }
      const handle = await fs.open(serverPath, 'r');
      let first: string | null;
      try {
        const stat = await handle.stat(), cursor = intent.cursor ?? 0;
        if (intent.cursor !== null) {
          const bytes = Buffer.alloc(Math.min(cursor, 4096));
          if (stat.size < cursor || (await handle.read(bytes, 0, bytes.length, cursor - bytes.length)).bytesRead !== bytes.length || evidenceHash(bytes) !== intent.anchor) { unknown = true; continue; }
        }
        if (e.startByte < cursor) continue;
        const size = stat.size - cursor;
        if (size < 0 || size > 2 * 1024 * 1024) throw Error('Native origin scan bound');
        const bytes = Buffer.alloc(size);
        if ((await handle.read(bytes, 0, size, cursor)).bytesRead !== size) throw Error('Native origin changed');
        first = firstNativeId(bytes, e.provider, e.providerConversationId, intent.seenNativeIds);
        // Claude Submit can precede persistence: an unchanged exact cursor proves the first claim.
        if (!first && e.provider === 'claude-code' && e.startByte === cursor && stat.size === cursor) first = nativeId;
      } finally { await handle.close(); }
      if (!first) { unknown = true; continue; }
      intent.nativeId = first; intent.source = source; await persist(file, intent);
      if (first === nativeId) automatic = true;
    }
    await persist(path.join(dir, 'source.json'), source);
    return unknown ? 'unknown' : automatic ? 'automation' : args.humanOrigin ? 'human' : 'unknown';
  } catch { return 'unknown'; }
}
