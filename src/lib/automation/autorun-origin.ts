import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import { evidenceHash } from './autorun-context';
import type { AutorunHookEvidence } from './autorun-contracts';
import type { RuntimeObservation } from './runtime-port';

type Scope = { userId: string; sessionId: string; agentEnvironment: 'native' | 'wsl' };
type Source = { canonicalPath: string; sourceIdentityHash: string; fileGeneration: string; providerConversationId: string };
type Intent = { version: 1; scope: Scope; runtime: Pick<RuntimeObservation, 'serverInstanceId' | 'generation' | 'terminalId'> | null;
  source: Source | null; cursor: number | null; fresh: boolean; submitted: boolean; nativeId?: string };
function directory(scope: Scope) { return getTesseraDataPath('autorun-origin', evidenceHash(JSON.stringify([scope.userId, scope.sessionId, scope.agentEnvironment]))); }
function read<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
/** The fenced write cannot race an awaited receipt. Sync the intent before irreversible PTY bytes. */
function persist(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID();
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function generationPath(source: Source, serverPath: string) { return path.join(path.dirname(serverPath), '.tessera-autorun', source.sourceIdentityHash + '.generation.json'); }
function checkGeneration(source: Source, serverPath: string) {
  return read<{ id: string }>(generationPath(source, serverPath))?.id === source.fileGeneration;
}

export async function prepareAutomationOrigin(args: Scope & { runId: string; runtime?: Intent['runtime']; fresh?: boolean }) {
  const scope: Scope = { userId: args.userId, sessionId: args.sessionId, agentEnvironment: args.agentEnvironment };
  const dir = directory(scope), file = path.join(dir, evidenceHash(JSON.stringify([args.runId, args.runtime?.serverInstanceId ?? null])) + '.intent.json');
  const source = args.fresh ? null : read<Source>(path.join(dir, 'source.json'));
  const serverPath = source ? await resolveAgentReportedPath(source.canonicalPath, scope.agentEnvironment) : null;
  let intent: Intent;
  return {
    begin() {
      if (read<Intent>(file)) throw Error('Origin write already attempted');
      let cursor: number | null = null;
      try {
        if (source && serverPath && checkGeneration(source, serverPath)) {
          const fd = fs.openSync(serverPath, 'r');
          try {
            const size = fs.fstatSync(fd).size, last = Buffer.alloc(1);
            if (size === 0 || fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 10) cursor = size;
          } finally { fs.closeSync(fd); }
        }
      } catch { /* Unknown source still leaves an intent; never guess human after a write. */ }
      intent = { version: 1, scope, runtime: args.runtime ?? null, source, cursor, fresh: args.fresh === true, submitted: false };
      persist(file, intent);
    },
    submitted() { if (!intent) throw Error('Missing origin intent'); intent.submitted = true; persist(file, intent); },
  };
}

/** Native IDs, never prompt text, join a host write to the first ensuing lead turn. */
function firstNativeId(bytes: Buffer, provider: 'codex' | 'claude-code', conversation: string): string | null {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text && !text.endsWith('\n')) throw Error('Incomplete native origin');
  for (const line of text.split('\n').filter(Boolean)) {
    if (Buffer.byteLength(line) > 1024 * 1024) throw Error('Native origin record bound');
    const r = JSON.parse(line);
    if (provider === 'codex' && r.type === 'event_msg' && r.payload?.type === 'task_started' && typeof r.payload.turn_id === 'string') return r.payload.turn_id;
    if (provider === 'claude-code' && r.type === 'user' && r.sessionId === conversation && typeof r.promptId === 'string' && !r.isSidechain && !r.isMeta && !r.isSynthetic && !r.isCompactSummary) return r.promptId;
  }
  return null;
}

export async function submissionOrigin(args: { event: Extract<AutorunHookEvidence, { kind: 'submission' }>; canonicalPath: string; humanOrigin: boolean }): Promise<'human' | 'automation' | 'unknown'> {
  const { event } = args, e = event.evidence;
  const scope: Scope = { userId: event.userId, sessionId: event.sessionId, agentEnvironment: event.agentEnvironment };
  const nativeId = e.provider === 'codex' ? e.nativeTurnId : e.nativePromptId;
  const source: Source = { canonicalPath: args.canonicalPath, sourceIdentityHash: e.sourceIdentityHash, fileGeneration: e.fileGeneration, providerConversationId: e.providerConversationId };
  if (!args.canonicalPath || evidenceHash(args.canonicalPath) !== e.sourceIdentityHash) return 'unknown';
  try {
    const serverPath = await resolveAgentReportedPath(source.canonicalPath, scope.agentEnvironment);
    if (!checkGeneration(source, serverPath)) return 'unknown';
    const dir = directory(scope);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.intent.json'));
    if (files.length > 100) return 'unknown';
    let automatic = false, unknown = false;
    for (const name of files) {
      const file = path.join(dir, name), intent = read<Intent>(file);
      if (!intent || intent.version !== 1 || JSON.stringify(intent.scope) !== JSON.stringify(scope)) return 'unknown';
      if (intent.source && (intent.source.sourceIdentityHash !== e.sourceIdentityHash || intent.source.fileGeneration !== e.fileGeneration || intent.source.providerConversationId !== e.providerConversationId)) {
        if (!intent.nativeId) unknown = true;
        continue;
      }
      if (intent.nativeId) { if (intent.nativeId === nativeId) automatic = true; continue; }
      if (intent.cursor !== null && e.startByte < intent.cursor) continue; // Earlier historical receipt.
      if (!intent.submitted || !intent.fresh && intent.cursor === null) { unknown = true; continue; }
      if (intent.runtime && (intent.runtime.serverInstanceId !== e.serverInstanceId || intent.runtime.generation !== e.terminalGeneration || intent.runtime.terminalId !== event.terminalId)) { unknown = true; continue; }
      const fd = fs.openSync(serverPath, 'r');
      let first: string | null;
      try {
        const stat = fs.fstatSync(fd), cursor = intent.cursor ?? 0, size = stat.size - cursor;
        if (size < 0 || size > 2 * 1024 * 1024) throw Error('Native origin scan bound');
        const bytes = Buffer.alloc(size);
        if (fs.readSync(fd, bytes, 0, size, cursor) !== size) throw Error('Native origin changed');
        first = firstNativeId(bytes, e.provider, e.providerConversationId);
        // Claude Submit precedes native persistence; an unchanged exact cursor proves the first claim.
        if (!first && e.provider === 'claude-code' && e.startByte === cursor && stat.size === cursor) first = nativeId;
      } finally { fs.closeSync(fd); }
      if (!first) { unknown = true; continue; }
      intent.nativeId = first; intent.source = source; persist(file, intent);
      if (first === nativeId) automatic = true;
    }
    persist(path.join(dir, 'source.json'), source);
    return unknown ? 'unknown' : automatic ? 'automation' : args.humanOrigin ? 'human' : 'unknown';
  } catch { return 'unknown'; }
}
