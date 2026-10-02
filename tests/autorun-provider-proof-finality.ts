import { z } from 'zod';

const text = z.string().min(1).max(2048);
const decisionSchema = z.object({
  outcome: z.enum(['continue', 'complete', 'needs-user']),
  proposedPrompt: z.string().min(1).max(32768).nullable(), explanation: text, progress: text,
  evidenceIds: z.array(z.string()).min(1).max(20),
  criterionResults: z.array(z.object({
    criterionId: z.string(), status: z.enum(['met', 'unmet', 'unknown']), evidenceIds: z.array(z.string()),
  }).strict()), madeProgress: z.boolean(), blocker: text.nullable(),
}).strict();
export interface ProcessSettlement {
  exitCode: number | null; cancelled: boolean; timedOut: boolean; quiescent: boolean;
}
export interface ProofPacket {
  criteria: { id: string }[]; messages: { id: string }[];
}
export function acceptSupervisorResult(provider: 'claude' | 'codex', output: Buffer,
  settled: ProcessSettlement, packet: ProofPacket): z.infer<typeof decisionSchema> {
  if (settled.exitCode !== 0 || settled.cancelled || settled.timedOut || !settled.quiescent) {
    throw new Error('supervisor did not settle successfully');
  }
  if (!output.length || output.length > 128 * 1024 || output.at(-1) !== 10) throw new Error('incomplete output');
  const events = output.toString('utf8').trimEnd().split('\n').map(s => JSON.parse(s));
  let value: unknown;
  if (provider === 'claude') {
    if (events.some(e => e.message?.content?.some((c: { type: string; name?: string }) =>
      c.type === 'tool_use' && c.name !== 'StructuredOutput'))) throw new Error('executable tool call');
    const finals = events.filter(e => e.type === 'result');
    if (finals.length !== 1 || finals[0].subtype !== 'success' || finals[0].is_error
      || finals[0].terminal_reason !== 'completed') throw new Error('no successful final result');
    value = finals[0].structured_output;
  } else {
    if (events.some(e => e.type === 'item.completed' && !['agent_message', 'reasoning'].includes(e.item?.type))) {
      throw new Error('tool receipt or provider error');
    }
    const finals = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
    if (finals.length !== 1 || events.filter(e => e.type === 'turn.completed').length !== 1
      || events.at(-1).type !== 'turn.completed' || events.some(e => e.type === 'error' || e.type === 'turn.failed')) {
      throw new Error('no successful final result');
    }
    value = JSON.parse(finals[0].item.text);
  }
  const decision = decisionSchema.parse(value);
  const evidence = new Set(packet.messages.map(m => m.id));
  const criteria = new Set(packet.criteria.map(c => c.id));
  const resultIds = decision.criterionResults.map(c => c.criterionId);
  if (resultIds.length !== criteria.size || new Set(resultIds).size !== criteria.size
    || resultIds.some(id => !criteria.has(id))
    || [...decision.evidenceIds, ...decision.criterionResults.flatMap(c => c.evidenceIds)].some(id => !evidence.has(id))) {
    throw new Error('decision cites unavailable evidence or criteria');
  }
  if (decision.outcome === 'complete' && decision.criterionResults.some(c => c.status !== 'met' || !c.evidenceIds.length)) {
    throw new Error('completion lacks criterion evidence');
  }
  if ((decision.outcome === 'continue') !== (decision.proposedPrompt !== null)
    || (decision.outcome === 'needs-user' && !decision.blocker)) throw new Error('invalid proposal or blocker');
  return decision;
}
