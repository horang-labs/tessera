import { ProviderIntegrationLaunchBlockedError } from '@/lib/cli/provider-integration';
import { ProviderLaunchError } from '@/lib/terminal/provider-launch-module';
import type { ServerTransportMessage } from './message-types';

type BlockMessage = Extract<ServerTransportMessage, { type: 'provider_integration_launch_blocked' }>;

function findProviderIntegrationBlock(error: unknown): ProviderIntegrationLaunchBlockedError | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof ProviderIntegrationLaunchBlockedError) return current;
    seen.add(current);
    current = current instanceof ProviderLaunchError ? current.cause : current.cause;
  }
  return null;
}

function integrationBlockReason(error: ProviderIntegrationLaunchBlockedError): BlockMessage['reason'] {
  const lifecycle = error.decision.lifecycle;
  const message = lifecycle.message?.toLowerCase() ?? '';
  if (lifecycle.consent === 'revoked' || message.includes('disabled')) return 'disabled';
  if (error.decision.guidance || message.includes('minimum supported')) return 'unsupported';
  if (lifecycle.state === 'conflict') return message.includes('write') ? 'write' : 'conflict';
  if (lifecycle.trust === 'untrusted') return 'trust';
  return 'unavailable';
}

export function buildProviderIntegrationBlockMessage(
  error: unknown,
  target: { providerId: string } & (
    | { terminalId: string; surfaceId: string }
    | { sessionId: string }
  ),
): BlockMessage | null {
  const blocked = findProviderIntegrationBlock(error);
  if (!blocked) return null;
  return {
    type: 'provider_integration_launch_blocked',
    ...target,
    reason: integrationBlockReason(blocked),
    title: 'Codex setup needs attention',
    message: blocked.decision.lifecycle.message
      ?? 'Tessera could not verify the required Codex Agent status hooks.',
    retryLabel: 'Retry setup',
    ...(blocked.decision.guidance?.updateCommand
      ? { updateCommand: blocked.decision.guidance.updateCommand }
      : {}),
  };
}
