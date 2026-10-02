import { AUTORUN_BOUNDS, validateSupervisorFinalResult, type SupervisorSelection, type SupervisorResult,
  type SupervisorFailureKind } from './autorun-contracts';

export type SupervisorProcessOutput = {
  selection: SupervisorSelection; cliVersion: string; invocationId: string;
  packet: { criteria: { id: string }[]; context: { items: { id: string }[] } };
  stdout: Buffer; stderr: Buffer; exitCode: number | null; quiescent: boolean; cancelled: boolean; timedOut: boolean; overflow?: boolean;
};
export function supervisorFailure(args: Pick<SupervisorProcessOutput, 'invocationId' | 'quiescent' | 'exitCode'>,
  kind: SupervisorFailureKind): Exclude<SupervisorResult, { kind: 'ok' }> {
  const codes = { cancelled: 'SUPERVISOR_CANCELLED', timeout: 'SUPERVISOR_TIMEOUT', capacity: 'SUPERVISOR_CAPACITY',
    auth: 'SUPERVISOR_AUTH', unsupported: 'SUPERVISOR_UNSUPPORTED', 'invalid-output': 'SUPERVISOR_INVALID_OUTPUT', 'provider-error': 'SUPERVISOR_PROVIDER_ERROR' } as const;
  return { kind, code: args.quiescent ? codes[kind] : 'SUPERVISOR_PROCESS_UNCERTAIN', invocationId: args.invocationId,
    settlement: { quiescent: args.quiescent, exitCode: args.exitCode } };
}
interface StreamEvent {
  type?: string; subtype?: string; is_error?: boolean; terminal_reason?: string; structured_output?: unknown;
  model?: string; tools?: string[]; mcp_servers?: unknown[]; skills?: unknown[]; plugins?: { name: string; source: string; path: string }[];
  message?: { content?: { type?: string; name?: string }[] }; item?: { type?: string; text?: string };
  error?: { code?: string; type?: string }; code?: string;
}
/** Partial messages are never decisions. This pure seam is also used after real owned-process settlement. */
export function parseSupervisorResult(args: SupervisorProcessOutput): SupervisorResult {
  const fail = (kind: SupervisorFailureKind) => supervisorFailure(args, kind);
  if (!args.quiescent) return fail('provider-error');
  if (args.cancelled) return fail('cancelled');
  if (args.timedOut) return fail('timeout');
  if (args.overflow || args.stdout.length > AUTORUN_BOUNDS.stdoutBytes || args.stderr.length > AUTORUN_BOUNDS.stderrBytes) return fail('invalid-output');
  let events: StreamEvent[];
  try {
    if (!args.stdout.length || args.stdout.at(-1) !== 10) return fail(args.exitCode === 0 ? 'invalid-output' : 'provider-error');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(args.stdout);
    events = text.trimEnd().split('\n').map(line => JSON.parse(line));
    if (events.some(e => !e || typeof e !== 'object' || Array.isArray(e))) return fail('invalid-output');
  } catch { return fail('invalid-output'); }
  const errors = events.filter(e => e.type === 'error' || e.type === 'turn.failed');
  if (args.exitCode !== 0 || errors.length) {
    const codes = errors.map(e => e.error?.code ?? e.error?.type ?? e.code);
    if (codes.some(c => ['rate_limit_exceeded', 'overloaded_error', 'capacity_exceeded'].includes(c ?? ''))) return fail('capacity');
    if (codes.some(c => ['authentication_error', 'unauthorized', 'invalid_api_key'].includes(c ?? ''))) return fail('auth');
    return fail('provider-error');
  }
  let decision: unknown;
  let finality: unknown;
  const effectiveSelection: unknown = { kind: 'requested-only' };
  if (args.selection.provider === 'claude-code') {
    const init = events.filter(e => e.type === 'system' && e.subtype === 'init');
    if (init.length !== 1) return fail('invalid-output');
    if (init.length) {
      const value = init[0];
      if (!Array.isArray(value.tools) || !Array.isArray(value.mcp_servers) || !Array.isArray(value.skills) ||
          !Array.isArray(value.plugins) || value.plugins.some(p => !p || typeof p !== 'object' ||
            typeof p.name !== 'string' || typeof p.source !== 'string' || typeof p.path !== 'string')) return fail('invalid-output');
      if (value.model !== args.selection.model || JSON.stringify(value.tools) !== '["StructuredOutput"]' ||
          value.mcp_servers?.length !== 0 || value.skills?.length !== 0 || value.plugins?.some(p => p.path !== 'builtin' || !['agents-md@builtin', 'telemetry@builtin'].includes(p.source))) return fail('unsupported');
      // Init attests model only; effort/tier remain requested.
    }
    if (events.some(e => e.message?.content?.some(b => b.type === 'tool_use' && b.name !== 'StructuredOutput'))) return fail('invalid-output');
    const finals = events.filter(e => e.type === 'result');
    if (finals.length !== 1 || events.at(-1) !== finals[0] || finals[0].subtype !== 'success' || finals[0].is_error !== false || finals[0].terminal_reason !== 'completed') return fail('invalid-output');
    decision = finals[0].structured_output;
    finality = { provider: 'claude-code', event: 'result/success', isError: false, terminalReason: 'completed', structuredDecisionCount: 1, executableReceipts: 0 };
  } else {
    if (events.some(e => e.type?.startsWith('item.') && !['agent_message', 'reasoning'].includes(e.item?.type ?? ''))) return fail('invalid-output');
    const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
    if (messages.length !== 1 || events.filter(e => e.type === 'turn.completed').length !== 1 || events.at(-1)?.type !== 'turn.completed' ||
        events.indexOf(messages[0]) >= events.length - 1) return fail('invalid-output');
    try { decision = JSON.parse(messages[0].item!.text!); } catch { return fail('invalid-output'); }
    finality = { provider: 'codex', event: 'turn.completed', structuredDecisionCount: 1, executableReceipts: 0 };
  }
  const result = validateSupervisorFinalResult({ kind: 'ok', decision, selection: args.selection, cliVersion: args.cliVersion,
    effectiveSelection, invocationId: args.invocationId, settlement: { exitCode: 0, quiescent: true }, finality },
  { selection: args.selection, criterionIds: args.packet.criteria.map(c => c.id), evidenceIds: args.packet.context.items.map(i => i.id) });
  return result.success ? result.data : fail('invalid-output');
}
