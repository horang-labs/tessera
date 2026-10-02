// R0a executable proof, not a product snapshot service or frozen R0 contract.
export interface TurnProof {
  provider: 'claude' | 'codex'; sessionId: string; submitId: string;
  stopId: string; finalText: string; blocked: boolean;
}
interface RecordValue {
  type?: string; uuid?: string; parentUuid?: string; sessionId?: string;
  promptId?: string; isSidechain?: boolean;
  message?: { id?: string; content?: string | { type: string; text?: string; id?: string; tool_use_id?: string }[] };
  payload?: { id?: string; type?: string; turn_id?: string; thread_source?: string; error?: unknown };
}
export function correlateCompletedTurn(bytes: Buffer, proof: TurnProof): { recordId: string; end: number } {
  if (proof.blocked || !proof.submitId || proof.submitId !== proof.stopId) throw new Error('unsafe boundary');
  const records: { value: RecordValue; end: number }[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    if (newline < 0) break; // delayed final flush: an incomplete record never qualifies
    records.push({ value: JSON.parse(bytes.subarray(start, newline).toString('utf8')), end: newline + 1 });
    start = newline + 1;
  }
  if (proof.provider === 'codex') {
    const meta = records.filter(r => r.value.type === 'session_meta');
    if (meta.length !== 1 || meta[0].value.payload?.id !== proof.sessionId
      || meta[0].value.payload?.thread_source !== 'user') throw new Error('binding unavailable');
    const starts = records.filter(r => r.value.type === 'event_msg'
      && r.value.payload?.type === 'task_started' && r.value.payload.turn_id === proof.submitId);
    const ends = records.filter(r => r.value.type === 'event_msg'
      && r.value.payload?.type === 'task_complete' && r.value.payload.turn_id === proof.submitId);
    if (starts.length !== 1 || ends.length !== 1 || ends[0].end <= starts[0].end
      || ends[0].value.payload?.error) throw new Error('completion unavailable or ambiguous');
    const span = records.filter(r => r.end > starts[0].end && r.end <= ends[0].end);
    if (!span.some(r => r.value.type === 'turn_context' && r.value.payload?.turn_id === proof.submitId)
      || span.some(r => r.value.type === 'event_msg' && r.value.payload?.type === 'task_started')) {
      throw new Error('turn mapping unavailable');
    }
    return { recordId: proof.submitId, end: ends[0].end };
  }
  const users = records.filter(r => r.value.type === 'user' && r.value.promptId === proof.submitId
    && r.value.sessionId === proof.sessionId && !r.value.isSidechain);
  if (users.length !== 1 || !users[0].value.uuid) throw new Error('submission unavailable');
  const lineage = new Set([users[0].value.uuid]);
  const candidates = [];
  const pendingTools = new Set<string>();
  for (const r of records.slice(records.indexOf(users[0]) + 1)) {
    const v = r.value;
    if (v.type === 'user' && v.promptId && v.promptId !== proof.submitId) break;
    if (v.isSidechain || v.sessionId !== proof.sessionId || !v.parentUuid || !lineage.has(v.parentUuid)) continue;
    if (v.uuid) lineage.add(v.uuid);
    if (Array.isArray(v.message?.content)) {
      for (const c of v.message.content) {
        if (c.type === 'tool_use' && c.id) pendingTools.add(c.id);
        if (c.type === 'tool_result' && c.tool_use_id) pendingTools.delete(c.tool_use_id);
      }
    }
    const text = typeof v.message?.content === 'string' ? v.message.content
      : v.message?.content?.filter(c => c.type === 'text').map(c => c.text).join('');
    if (v.type === 'assistant' && text === proof.finalText && v.uuid) candidates.push(r);
  }
  if (pendingTools.size) throw new Error('unresolved tool pair');
  if (candidates.length !== 1) throw new Error('completion unavailable or ambiguous');
  return { recordId: candidates[0].value.uuid!, end: candidates[0].end };
}

export interface WorkerReceipt {
  hook_event_name: string; session_id: string; prompt_id?: string; turn_id?: string;
  last_assistant_message?: string;
}
export function verifyWorkerTurns(provider: TurnProof['provider'], receipts: WorkerReceipt[]): TurnProof[] {
  const submits = receipts.filter(e => e.hook_event_name === 'UserPromptSubmit');
  const stops = receipts.filter(e => e.hook_event_name === 'Stop');
  if (submits.length !== 2 || stops.length !== 2) throw new Error('two submitted and completed turns required');
  const id = (e: WorkerReceipt) => provider === 'claude' ? e.prompt_id : e.turn_id;
  const identities = submits.map(id);
  if (identities.some(i => !i) || new Set(identities).size !== 2
    || new Set(receipts.map(e => e.session_id)).size !== 1) throw new Error('worker binding unavailable');
  const proofs = submits.map(submit => {
    const matches = stops.filter(stop => id(stop) === id(submit) && stop.session_id === submit.session_id);
    if (matches.length !== 1 || !matches[0].last_assistant_message
      || receipts.indexOf(matches[0]) < receipts.indexOf(submit)) throw new Error('unpaired completion');
    return { provider, sessionId: submit.session_id, submitId: id(submit)!, stopId: id(matches[0])!,
      finalText: matches[0].last_assistant_message!, blocked: false };
  });
  if (proofs[0].finalText !== proofs[1].finalText) throw new Error('identical finals required for this proof');
  return proofs;
}
