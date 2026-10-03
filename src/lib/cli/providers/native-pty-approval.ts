import { createHash } from 'node:crypto';
import { z } from 'zod';
import { nativeApprovalRequestSchema, type NativeApprovalRequest, type NativeRuntimeIdentity } from '@/lib/automation/activation-contracts';
import { supportsNativeInteraction } from './native-pty-prompt';

const hookSchema = z.object({ hook_event_name: z.literal('PermissionRequest'), session_id: z.string().min(1),
  tool_name: z.string().min(1).max(256), tool_input: z.record(z.unknown()), cwd: z.string().min(1).max(256),
  tessera_native_approval: z.object({ invocationId: z.string().min(1).max(256), generation: z.number().int().nonnegative(),
    providerVersion: z.string() }).strict() });
/** Caller must already authenticate the pane and correlate this request with the accepted lead. */
export function readNativeApprovalRequest(identity: NativeRuntimeIdentity, payload: Record<string, unknown>): NativeApprovalRequest | null {
  const parsed = hookSchema.safeParse(payload);
  if (!parsed.success) return null;
  const hook = parsed.data, proof = hook.tessera_native_approval;
  if (hook.session_id !== identity.providerConversationId || proof.generation !== identity.generation
    || !supportsNativeInteraction(identity.provider, proof.providerVersion)
    || /^(?:AskUserQuestion|ask_user_question|ExitPlanMode|enter_plan_mode|exit_plan_mode)$/i.test(hook.tool_name)) return null;
  const context = JSON.stringify({ toolName: hook.tool_name, cwd: hook.cwd, input: hook.tool_input });
  if (Buffer.byteLength(context) > 32_768) return null;
  const command = hook.tool_input.command ?? hook.tool_input.cmd;
  const request = { requestId: proof.invocationId, nativeRequestId: proof.invocationId, identity,
    options: [{ id: 'allow-once', effect: 'approve-once' }, { id: 'deny', effect: 'deny' }],
    context: { text: context, complete: true }, deadlineAt: Date.now() + 90_000,
    ...(typeof command === 'string' && ['Bash', 'exec_command', 'shell', 'shell_command'].includes(hook.tool_name)
      ? { kind: 'command', operation: { command, cwd: hook.cwd } }
      : { kind: 'permission', operation: { toolName: hook.tool_name, input: hook.tool_input } }) };
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const result = nativeApprovalRequestSchema.safeParse({ ...request, requestHash });
  return result.success ? result.data : null;
}
