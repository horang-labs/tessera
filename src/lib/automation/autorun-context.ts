import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AUTORUN_BOUNDS, analysisContextSnapshotSchema, type AnalysisContextResult, type ContextItem,
  type ContextUnavailableReason, type ProviderCompletionCutoff } from './autorun-contracts';
import type { AnalysisSnapshotRequest } from '@/lib/cli/providers/session-types';

export const evidenceHash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
/** No-progress evidence is separate from the native context integrity digest. */
export function hashWorkerEvidence(items: readonly ContextItem[]): string {
  return evidenceHash(JSON.stringify(items.filter(i => i.role === 'assistant' || i.role.startsWith('tool'))
    .map(i => [i.role, i.text.replace(/\s+/g, ' ').trim()])));
}
export type NativeContextSource = { path: string; canonicalPath: string; identityHash: string; fileGeneration: string; cliVersion: string };
export type ContextReaderDependencies = {
  resolveSource(request: AnalysisSnapshotRequest): Promise<NativeContextSource | null>;
  verifyBinding(request: AnalysisSnapshotRequest): Promise<boolean>;
  flushWaitMs?: number;
};
export interface NativeRecord {
  type?: string; uuid?: string; parentUuid?: string; sessionId?: string; promptId?: string;
  isSidechain?: boolean; isMeta?: boolean; isSynthetic?: boolean; isCompactSummary?: boolean;
  subtype?: string; message?: { id?: string; content?: string | NativeBlock[] };
  payload?: { id?: string; type?: string; turn_id?: string; thread_source?: string; error?: unknown;
    role?: string; content?: NativeBlock[]; call_id?: string; name?: string; arguments?: string; input?: string; output?: string | NativeBlock[]; last_agent_message?: string };
}
interface NativeBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | NativeBlock[];
  image_url?: string; file_id?: string; detail?: string | null; audio_url?: string; encrypted_content?: string }
export type LocatedRecord = { value: NativeRecord; start: number; end: number };
class ContextError extends Error { constructor(readonly reason: ContextUnavailableReason) { super(reason); } }
function refuse(reason: ContextUnavailableReason): never { throw new ContextError(reason); }
const unavailable = (reason: ContextUnavailableReason): Extract<AnalysisContextResult, { kind: 'unavailable' }> => ({ kind: 'unavailable',
  code: reason === 'stale' ? 'ANALYSIS_STALE' : ['flush-pending', 'unresolved-tools', 'compacted-latest-turn', 'malformed'].includes(reason) ? 'CONTEXT_INCOMPLETE' : 'CONTEXT_UNAVAILABLE', reason });

function parseRecords(bytes: Buffer, start: number): LocatedRecord[] {
  const records: LocatedRecord[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const end = bytes.indexOf(10, cursor);
    if (end < 0) break;
    if (end - cursor > AUTORUN_BOUNDS.recordBytes) refuse('record-limit');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor, end));
      const value = JSON.parse(text) as NativeRecord;
      if (!value || typeof value !== 'object' || Array.isArray(value) || !value.type) refuse('malformed');
      records.push({ value, start: start + cursor, end: start + end + 1 });
    } catch (e) { if (e instanceof ContextError) throw e; refuse('malformed'); }
    cursor = end + 1;
  }
  if (bytes.length - cursor > AUTORUN_BOUNDS.recordBytes) refuse('record-limit');
  return records;
}
function nativeText(content: string | NativeBlock[] | undefined): string {
  return typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text' || b.type === 'input_text' || b.type === 'output_text').map(b => b.text ?? '').join('');
}
function claudeCutoff(records: LocatedRecord[], request: AnalysisSnapshotRequest): { cutoff: ProviderCompletionCutoff; latestStart: number } {
  const correlation = request.correlation;
  if (correlation.provider !== 'claude-code') return refuse('binding-mismatch');
  const users = records.filter(r => r.value.type === 'user' && r.value.promptId === correlation.nativePromptId && !r.value.isSidechain);
  if (users.length > 1) refuse('ambiguous-cutoff');
  if (!users.length) refuse('flush-pending');
  const user = users[0];
  if (user.start < correlation.startByte) refuse('binding-mismatch');
  if (!user.value.uuid || user.value.sessionId !== request.providerConversationId) refuse('binding-mismatch');
  const lineage = new Set([user.value.uuid]);
  const ids = new Set([user.value.uuid]);
  const pending = new Set<string>();
  const finals: LocatedRecord[] = [];
  for (const record of records.filter(r => r.start > user.start)) {
    const v = record.value;
    if (v.type === 'user' && v.promptId && v.promptId !== correlation.nativePromptId && !v.isSidechain) break;
    if (v.isSidechain) refuse('unsafe-runtime');
    if (['queue-operation', 'atis-latch', 'last-prompt', 'cost-state', 'mode'].includes(v.type ?? '') && !v.uuid && v.sessionId === request.providerConversationId) continue;
    if (v.isCompactSummary || (v.type === 'system' && v.subtype === 'compact_boundary')) refuse('compacted-latest-turn');
    if (v.sessionId !== request.providerConversationId || !v.uuid || !v.parentUuid || !lineage.has(v.parentUuid)) refuse('ambiguous-cutoff');
    if (ids.has(v.uuid)) refuse('ambiguous-cutoff');
    ids.add(v.uuid); lineage.add(v.uuid);
    if (Array.isArray(v.message?.content)) for (const block of v.message.content) {
      if (block.type === 'tool_use') { if (!block.id || pending.has(block.id)) refuse('unresolved-tools'); pending.add(block.id); }
      if (block.type === 'tool_result') { if (!block.tool_use_id || !pending.delete(block.tool_use_id)) refuse('unresolved-tools'); }
    }
    if (v.type === 'assistant' && nativeText(v.message?.content) && evidenceHash(nativeText(v.message?.content)) === correlation.stopTextHash) {
      if (pending.size) refuse('unresolved-tools');
      finals.push(record);
    }
  }
  if (pending.size) refuse('unresolved-tools');
  if (!finals.length) refuse('flush-pending');
  if (finals.length !== 1) refuse('ambiguous-cutoff');
  const final = finals[0];
  return { latestStart: user.start, cutoff: { provider: 'claude-code', promptId: correlation.nativePromptId, humanRecordId: user.value.uuid!,
    terminalRecordId: final.value.uuid!, parentUuid: final.value.parentUuid!, apiMessageId: final.value.message?.id ?? null, endByte: final.end } };
}
function codexCutoff(records: LocatedRecord[], request: AnalysisSnapshotRequest): { cutoff: ProviderCompletionCutoff; latestStart: number } {
  const c = request.correlation;
  if (c.provider !== 'codex') return refuse('binding-mismatch');
  const meta = records.filter(r => r.value.type === 'session_meta');
  if (meta.length !== 1 || meta[0].value.payload?.id !== request.providerConversationId || meta[0].value.payload?.thread_source !== 'user') refuse('binding-mismatch');
  const starts = records.filter(r => r.value.type === 'event_msg' && r.value.payload?.type === 'task_started' && r.value.payload.turn_id === c.nativeTurnId);
  const ends = records.filter(r => r.value.type === 'event_msg' && ['task_complete', 'turn_complete'].includes(r.value.payload?.type ?? '') && r.value.payload?.turn_id === c.nativeTurnId);
  if (starts.length > 1 || ends.length > 1) refuse('ambiguous-cutoff');
  if (!starts.length || !ends.length) refuse('flush-pending');
  const start = starts[0], end = ends[0];
  if (end.start <= start.start || end.value.payload?.error) refuse('unsafe-runtime');
  const span = records.filter(r => r.start >= start.start && r.end <= end.end);
  const contexts = span.filter(r => r.value.type === 'turn_context' && r.value.payload?.turn_id === c.nativeTurnId);
  if (contexts.length !== 1 || span.some(r => (r.value.type === 'event_msg' &&
      ['task_started', 'turn_aborted', 'error', 'approval_request'].includes(r.value.payload?.type ?? '') && r !== start) || r.value.type === 'compacted')) refuse('unsafe-runtime');
  const pending = new Set<string>();
  for (const r of span) {
    const p = r.value.payload;
    if (r.value.type !== 'response_item' || !p) continue;
    if (['function_call', 'custom_tool_call'].includes(p.type ?? '')) {
      if (!p.call_id || pending.has(p.call_id)) refuse('unresolved-tools'); pending.add(p.call_id!);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type ?? '')) {
      if (!p.call_id || !pending.delete(p.call_id)) refuse('unresolved-tools');
    }
  }
  if (pending.size) refuse('unresolved-tools');
  const recordId = (r: LocatedRecord) => `codex:${r.start}`;
  return { latestStart: start.start, cutoff: { provider: 'codex', turnId: c.nativeTurnId,
    taskStartedRecordId: recordId(start), turnContextRecordId: recordId(contexts[0]), terminalRecordId: recordId(end), endByte: end.end } };
}
function excerpt(text: string, max: number): string {
  const buffer = Buffer.from(text);
  let end = Math.min(max, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
function itemText(text: string, tool: boolean): { text: string; omission: ContextItem['omission'] } {
  if (!tool || Buffer.byteLength(text) <= AUTORUN_BOUNDS.toolExcerptBytes) return { text, omission: 'none' };
  const marker = '\n[tool output omitted]\n';
  const half = Math.floor((AUTORUN_BOUNDS.toolExcerptBytes - Buffer.byteLength(marker)) / 2);
  const bytes = Buffer.from(text);
  let start = bytes.length - half;
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return { text: excerpt(text, half) + marker + bytes.subarray(start).toString('utf8'), omission: 'head-tail' };
}
/** Codex 0.159.2 FunctionCallOutputBody: text or content items, for both tool families. */
function codexToolOutput(output: NonNullable<NativeRecord['payload']>['output']): { text: string; nonText: boolean } {
  if (typeof output === 'string') return { text: output, nonText: false };
  if (!Array.isArray(output)) return refuse('malformed');
  const texts: string[] = []; let nonText = false;
  for (const block of output) {
    if (!block || typeof block !== 'object') refuse('malformed');
    if (block.type === 'input_text') {
      if (typeof block.text !== 'string') refuse('malformed');
      if (block.text.trim()) texts.push(block.text);
    } else if (block.type === 'input_image') {
      if (typeof block.image_url !== 'string' && typeof block.file_id !== 'string') refuse('malformed');
      if (block.detail != null && !['auto', 'low', 'high', 'original'].includes(block.detail)) refuse('malformed');
      nonText = true;
    } else if (block.type === 'input_audio' || block.type === 'encrypted_content') {
      if (typeof (block.type === 'input_audio' ? block.audio_url : block.encrypted_content) !== 'string') refuse('malformed');
      nonText = true;
    } else refuse('malformed');
  }
  return { text: texts.join('\n'), nonText };
}
function contextItems(records: LocatedRecord[], provider: 'claude-code' | 'codex'): ContextItem[] {
  const items: ContextItem[] = [];
  for (const record of records) {
    const v = record.value;
    const base = { startByte: record.start, endByte: record.end, origin: 'provider' as ContextItem['origin'] };
    const id = v.uuid ?? `${provider}:${record.start}`;
    const add = (role: ContextItem['role'], text: string, suffix = '', omission?: ContextItem['omission']) => {
      if (text.trim()) items.push({ ...base, id: id + suffix, role, ...itemText(text, role.startsWith('tool')), ...(omission ? { omission } : {}) });
    };
    if (v.isCompactSummary || (v.type === 'system' && v.subtype === 'compact_boundary')) { add('compaction', '[Earlier conversation compacted]', '', 'range'); continue; }
    if (provider === 'codex') {
      const p = v.payload;
      if (v.type === 'compacted') { add('compaction', '[Earlier conversation compacted]', '', 'range'); continue; }
      if (v.type === 'response_item' && p) {
        if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
          add(p.role, nativeText(p.content));
          if (p.content?.some(b => !['input_text', 'output_text', 'text'].includes(b.type))) add('omitted', '[Nontext content omitted]', ':nontext', 'non-text');
        } else if (['function_call', 'custom_tool_call'].includes(p.type ?? '')) {
          const field = p.type === 'custom_tool_call' ? 'input' : 'arguments';
          if (typeof p.name !== 'string' || typeof p.call_id !== 'string' || typeof p[field] !== 'string') refuse('malformed');
          add('tool-call', JSON.stringify({ name: p.name, [field]: p[field] }), ':call');
        }
        else if (['function_call_output', 'custom_tool_call_output'].includes(p.type ?? '')) {
          const output = codexToolOutput(p.output);
          add('tool-result', output.text || '[Nontext tool output]', ':result', !output.text ? 'non-text' : undefined);
          if (output.nonText && output.text) add('omitted', '[Nontext tool output omitted]', ':result:nontext', 'non-text');
        }
      }
      // Sanitized #530 lifecycle fixtures retain final text even without response items.
      if (v.type === 'event_msg' && ['task_complete', 'turn_complete'].includes(p?.type ?? '') && p?.last_agent_message &&
          !records.some(r => r.value.type === 'response_item' && r.value.payload?.role === 'assistant')) add('assistant', p.last_agent_message);
      continue;
    }
    if (v.type !== 'user' && v.type !== 'assistant') continue;
    if (v.isSidechain) continue;
    if (v.isMeta || v.isSynthetic) { add('omitted', '[Injected provider instructions omitted]', '', 'range'); continue; }
    const content = v.message?.content;
    add(v.type, nativeText(content));
    if (Array.isArray(content)) content.forEach((b, index) => {
      if (b.type === 'tool_use') add('tool-call', JSON.stringify({ name: b.name, input: b.input }), `:call:${b.id ?? index}`);
      else if (b.type === 'tool_result') add('tool-result', nativeText(b.content) || '[Nontext tool output]', `:result:${b.tool_use_id ?? index}`, !nativeText(b.content) ? 'non-text' : undefined);
      else if (!['text', 'thinking', 'redacted_thinking'].includes(b.type)) add('omitted', '[Nontext content omitted]', `:nontext:${index}`, 'non-text');
    });
  }
  return items;
}

/** Exact native bytes at the gate-qualified boundary; never a UI/export replay substitute. */
export async function readAnalysisContext(request: AnalysisSnapshotRequest, deps: ContextReaderDependencies): Promise<AnalysisContextResult> {
  const deadline = Date.now() + Math.min(deps.flushWaitMs ?? AUTORUN_BOUNDS.flushWaitMs, AUTORUN_BOUNDS.flushWaitMs);
  let bytesScanned = 0;
  for (;;) {
    try {
      if (request.signal.aborted || !request.userId || request.userId !== request.expectedBoundary.userId ||
        request.sessionId !== request.expectedBoundary.sessionId || !await deps.verifyBinding(request)) refuse('stale');
      const source = await deps.resolveSource(request);
      if (!source) refuse('missing');
      const c = request.correlation;
      if (source.identityHash !== c.sourceIdentityHash || source.fileGeneration !== c.fileGeneration || c.providerConversationId !== request.providerConversationId ||
        c.serverInstanceId !== request.expectedBoundary.serverInstanceId || c.terminalGeneration !== request.expectedBoundary.generation) refuse('binding-mismatch');
      if (source.cliVersion !== (c.provider === 'codex' ? '0.159.2' : '2.1.284')) refuse('unsupported-version');
      const handle = await fs.open(source.path, 'r');
      const recordBytes: { start: number; bytes: Buffer }[] = [];
      let records: LocatedRecord[]; let ranges: { startByte: number; endByte: number }[]; let maxRecordBytes = 1;
      try {
        const stat = await handle.stat();
        const budget = AUTORUN_BOUNDS.scanBytes - bytesScanned;
        if (budget <= AUTORUN_BOUNDS.recordBytes) refuse('scan-limit');
        // Select the same captured windows on either side of the scan-size threshold.
        // The frozen cursor anchors older context, with backward coverage for Codex lifecycle records.
        const tailStart = Math.max(AUTORUN_BOUNDS.recordBytes, c.startByte - 8 * 1024 * 1024);
        const windows = tailStart === AUTORUN_BOUNDS.recordBytes ? [{ start: 0, length: Math.min(stat.size, budget) }] : [
          { start: 0, length: Math.min(stat.size, AUTORUN_BOUNDS.recordBytes) },
          { start: tailStart, length: Math.max(0, Math.min(stat.size - tailStart, budget - AUTORUN_BOUNDS.recordBytes)) },
        ];
        records = []; ranges = [];
        for (const window of windows) {
          const bytes = Buffer.alloc(window.length);
          const read = await handle.read(bytes, 0, bytes.length, window.start);
          bytesScanned += read.bytesRead;
          const available = bytes.subarray(0, read.bytesRead);
          const skip = window.start === 0 ? 0 : available.indexOf(10) + 1;
          if (window.start !== 0 && skip === 0) refuse('record-limit');
          records.push(...parseRecords(available.subarray(skip), window.start + skip));
          recordBytes.push({ start: window.start + skip, bytes: available.subarray(skip) });
          if (read.bytesRead) ranges.push({ startByte: window.start + skip, endByte: window.start + read.bytesRead });
        }
        maxRecordBytes = records.reduce((max, r) => Math.max(max, r.end - r.start), 1);
        const after = await handle.stat();
        if (after.ino !== stat.ino || after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) refuse('stale');
      } finally { await handle.close(); }
      const { cutoff, latestStart } = c.provider === 'codex' ? codexCutoff(records, request) : claudeCutoff(records, request);
      ranges = ranges.map(r => ({ ...r, endByte: Math.min(r.endByte, cutoff.endByte) })).filter(r => r.endByte > r.startByte);
      const selected = records.filter(r => r.end <= cutoff.endByte);
      const items = contextItems(selected, c.provider);
      const omittedRanges = ranges.slice(1).flatMap((range, i) => range.startByte > ranges[i].endByte ? [{ startByte: ranges[i].endByte, endByte: range.startByte }] : []);
      // Earlier items yield space to the entire latest turn; never silently clip that turn.
      while (Buffer.byteLength(JSON.stringify(items)) > AUTORUN_BOUNDS.packetBytes - 8192 && items[0]?.endByte <= latestStart) {
        const removed = items.shift()!;
        omittedRanges.push({ startByte: removed.startByte, endByte: removed.endByte });
      }
      const snapshot = { version: 1, provider: c.provider, cliVersion: source.cliVersion, providerConversationId: request.providerConversationId,
        userId: request.userId, agentEnvironment: request.agentEnvironment, boundary: request.expectedBoundary, inputEpoch: request.inputEpoch,
        workerSelection: request.workerSelection, correlation: c, source: { identityHash: source.identityHash, fileGeneration: source.fileGeneration,
          startByte: 0, endByte: cutoff.endByte, latestTurnStartByte: latestStart, scannedRanges: ranges, bytesScanned, maxRecordBytes },
        cutoff, coverage: { kind: omittedRanges.length ? 'bounded' : items.some(i => i.role === 'compaction') ? 'compacted' : 'full', latestTurnComplete: true, omittedRanges, omittedBytes: omittedRanges.reduce((sum, range) => sum + range.endByte - range.startByte, 0),
          toolTruncation: items.some(i => i.omission === 'head-tail'), compactionRecordIds: items.filter(i => i.role === 'compaction').map(i => i.id) },
        items, parserVersion: 'autorun-native-v1', contentHash: evidenceHash(Buffer.concat(recordBytes.map(r => r.bytes.subarray(0, Math.max(0, cutoff.endByte - r.start))))), capturedAt: Date.now() };
      if (request.signal.aborted || !await deps.verifyBinding(request)) refuse('stale');
      const parsed = analysisContextSnapshotSchema.safeParse(snapshot);
      return parsed.success ? { kind: 'ok', snapshot: parsed.data } : unavailable('packet-limit');
    } catch (error) {
      const reason = error instanceof ContextError ? error.reason : 'missing';
      if (reason !== 'flush-pending' || Date.now() >= deadline || request.signal.aborted) return unavailable(reason);
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal: request.signal }).catch(() => {});
    }
  }
}

export type EvidenceReaderDependencies = {
  resolveSource(request: import('@/lib/cli/providers/session-types').AutorunEvidenceRequest): Promise<NativeContextSource | null>;
  verifyBinding(request: import('@/lib/cli/providers/session-types').AutorunEvidenceRequest): Promise<boolean>;
  readHumanSubmissions(userId: string, sessionId: string): Promise<import('./autorun-human-evidence').HumanSubmission[] | null>;
};
/** Preview provenance is independent of completion. Unknown origin stays missing; R2 applies explicit overrides. */
export async function readAutorunEvidence(request: import('@/lib/cli/providers/session-types').AutorunEvidenceRequest,
  deps: EvidenceReaderDependencies): Promise<import('./autorun-contracts').AutorunEvidenceResult> {
  try {
    if (!request.userId || request.signal.aborted || !await deps.verifyBinding(request)) return unavailable('stale');
    const turn = request.turnEvidence;
    if (turn.kind === 'unavailable') return unavailable(turn.reason);
    if (turn.kind === 'idle') return { kind: 'ok', goal: { kind: 'missing', reason: 'no-human-instructions' }, newHumanInstructions: [], turnEvidence: turn };
    const native = turn.kind === 'running' ? turn.submission : turn.correlation;
    const runtime = turn.kind === 'running' ? turn.acceptedTurn : turn.boundary;
    if (runtime.userId !== request.userId || runtime.sessionId !== request.sessionId || native.providerConversationId !== request.providerConversationId ||
        runtime.serverInstanceId !== native.serverInstanceId || runtime.generation !== native.terminalGeneration) return unavailable('binding-mismatch');
    const source = await deps.resolveSource(request);
    if (!source) return unavailable('missing');
    if (source.identityHash !== native.sourceIdentityHash || source.fileGeneration !== native.fileGeneration) return unavailable('binding-mismatch');
    const handle = await fs.open(source.path, 'r');
    let records: LocatedRecord[];
    try {
      const stat = await handle.stat();
      const size = Math.min(stat.size, AUTORUN_BOUNDS.scanBytes);
      if (stat.size <= size) { const b = Buffer.alloc(size); const r = await handle.read(b, 0, size, 0); records = parseRecords(b.subarray(0, r.bytesRead), 0); }
      else {
        const header = Buffer.alloc(AUTORUN_BOUNDS.recordBytes);
        const h = await handle.read(header, 0, header.length, 0);
        const tail = Buffer.alloc(size - header.length), start = stat.size - tail.length;
        const t = await handle.read(tail, 0, tail.length, start);
        const skip = tail.indexOf(10) + 1;
        if (skip === 0) return unavailable('record-limit');
        records = [...parseRecords(header.subarray(0, h.bytesRead), 0), ...parseRecords(tail.subarray(skip, t.bytesRead), start + skip)];
      }
    } finally { await handle.close(); }
    const submissions = await deps.readHumanSubmissions(request.userId, request.sessionId);
    if (submissions === null) return { kind: 'ok', goal: { kind: 'missing', reason: 'unverified-human-origin' }, newHumanInstructions: [], turnEvidence: turn };
    let missingHumanEvidence = false;
    const verified: { text: string; source: Extract<import('./autorun-contracts').AutorunObjective, { kind: 'verified-human' }>['sources'][number]; offset: number }[] = [];
    for (const submission of submissions) {
      if (submission.origin !== 'human' || submission.sourceIdentityHash !== source.identityHash || submission.fileGeneration !== source.fileGeneration ||
          evidenceHash(submission.text) !== submission.textHash || /<\/?(?:environment_context|instructions|INSTRUCTIONS|command-name|local-command-stdout)\b|^# (?:AGENTS\.md|Instructions)/.test(submission.text)) continue;
      const matches = records.filter(r => native.provider === 'claude-code'
        ? r.value.type === 'user' && r.value.promptId === submission.nativeId && !r.value.isSidechain && !r.value.isMeta && !r.value.isSynthetic && !r.value.isCompactSummary &&
          r.value.sessionId === request.providerConversationId && nativeText(r.value.message?.content) === submission.text
        : r.value.type === 'response_item' && r.value.payload?.type === 'message' && r.value.payload.role === 'user' && nativeText(r.value.payload.content) === submission.text &&
          records.some(start => start.start < r.start && start.value.payload?.type === 'task_started' && start.value.payload.turn_id === submission.nativeId &&
            !records.some(next => next.start > start.start && next.start < r.start && next.value.payload?.type === 'task_started')));
      if (matches.length !== 1) { missingHumanEvidence = true; continue; }
      const record = matches[0], recordId = record.value.uuid ?? `codex:${record.start}`;
      verified.push({ text: submission.text, offset: record.start, source: { messageId: submission.observerSubmissionId, recordId,
        textHash: submission.textHash, excerpt: excerpt(submission.text, 2048), origin: 'tessera-human-correlated' } });
    }
    verified.sort((a, b) => a.offset - b.offset);
    if (request.signal.aborted || !await deps.verifyBinding(request)) return unavailable('stale');
    const text = verified.map(v => v.text).join('\n\n');
    const sources = verified.map(v => v.source);
    const newHumanInstructions = sources.filter(s => !request.previousHumanSourceIds.includes(s.recordId));
    if (missingHumanEvidence) return { kind: 'ok', goal: { kind: 'missing', reason: 'unverified-human-origin' }, newHumanInstructions, turnEvidence: turn };
    if (Buffer.byteLength(text) > AUTORUN_BOUNDS.objectiveConstraintBytes) return { kind: 'ok', goal: { kind: 'missing', reason: 'objective-limit' }, newHumanInstructions, turnEvidence: turn };
    if (!sources.length) return { kind: 'ok', goal: { kind: 'missing', reason: 'unverified-human-origin' }, newHumanInstructions, turnEvidence: turn };
    // Once a saved objective exists, corrections require an explicit reviewed override. Never silently discard a possible conflict.
    if (request.previousHumanSourceIds.length && newHumanInstructions.length) return { kind: 'ok', goal: { kind: 'conflicting', sources }, newHumanInstructions, turnEvidence: turn };
    return { kind: 'ok', goal: { kind: 'verified', objective: { kind: 'verified-human', text, revision: request.goalRevision, sources } }, newHumanInstructions, turnEvidence: turn };
  } catch (error) { return unavailable(error instanceof ContextError ? error.reason : 'missing'); }
}
