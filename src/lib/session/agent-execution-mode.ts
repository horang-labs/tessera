export type AgentExecutionMode = 'pty' | 'gui';

export interface ProviderExecutionCapabilities {
  pty: boolean;
  gui: boolean;
}

const PROVIDER_EXECUTION_CAPABILITIES: Record<string, ProviderExecutionCapabilities> = {
  'claude-code': { pty: true, gui: true },
  codex: { pty: true, gui: true },
  opencode: { pty: true, gui: true },
};

export function getProviderExecutionCapabilities(
  providerId: string,
): ProviderExecutionCapabilities {
  return PROVIDER_EXECUTION_CAPABILITIES[providerId]
    ?? { pty: false, gui: false };
}

export function resolveEffectiveExecutionMode(
  preferredMode: AgentExecutionMode,
  capabilities: ProviderExecutionCapabilities,
): AgentExecutionMode {
  if (preferredMode === 'pty' && capabilities.pty) return 'pty';
  if (preferredMode === 'gui' && capabilities.gui) return 'gui';
  if (capabilities.pty) return 'pty';
  if (capabilities.gui) return 'gui';
  throw new Error('Provider does not support an executable agent mode');
}

/**
 * Resolve the mode for a single session creation request.
 *
 * Explicit per-session choices are strict: silently switching them would make
 * the created session disagree with the radio state the user confirmed. Older
 * callers that omit a choice retain the compatible global-default behavior.
 */
export function resolveSessionCreationExecutionMode(
  requestedMode: AgentExecutionMode | undefined,
  preferredMode: AgentExecutionMode,
  capabilities: ProviderExecutionCapabilities,
): AgentExecutionMode {
  if (requestedMode !== undefined) {
    if (capabilities[requestedMode]) return requestedMode;
    throw new Error(`Provider does not support ${requestedMode} execution mode`);
  }
  return resolveEffectiveExecutionMode(preferredMode, capabilities);
}
