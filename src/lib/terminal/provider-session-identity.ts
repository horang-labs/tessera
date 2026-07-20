import type { SessionRow } from '@/lib/db/sessions';
import {
  extractCodexTerminalSessionId,
  extractOpenCodeTerminalSessionId,
} from '@/lib/db/sessions';

export interface TerminalProviderSessionIdentity {
  providerId: string;
  providerSessionId: string;
  transcriptPath?: string;
}

export type TerminalProviderSessionActivation = 'active' | 'background';

const MAX_PROVIDER_SESSION_ID_LENGTH = 512;

function normalizeProviderValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_PROVIDER_SESSION_ID_LENGTH
    || /[\x00-\x1f\x7f]/u.test(normalized)
  ) return undefined;
  return normalized;
}

export function extractTerminalProviderSessionIdentity(
  providerId: string,
  payload: Record<string, unknown>,
): TerminalProviderSessionIdentity | null {
  const providerSessionId = providerId === 'opencode'
    ? normalizeProviderValue(payload.sessionID ?? payload.session_id)
    : normalizeProviderValue(payload.session_id);
  if (!providerSessionId) return null;

  const transcriptPath = normalizeProviderValue(payload.transcript_path ?? payload.transcriptPath);
  return {
    providerId,
    providerSessionId,
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}

export function readPersistedTerminalProviderSessionId(session: SessionRow): string | undefined {
  const nativeForkSessionId = extractNativeForkProviderSessionId(session.provider_state);
  if (nativeForkSessionId) return nativeForkSessionId;
  if (session.provider === 'claude-code') return session.id;
  if (session.provider === 'codex') return extractCodexTerminalSessionId(session.provider_state);
  if (session.provider === 'opencode') return extractOpenCodeTerminalSessionId(session.provider_state);
  return undefined;
}

export function extractNativeForkProviderSessionId(
  providerState: string | null | undefined,
): string | undefined {
  if (!providerState) return undefined;
  try {
    const parsed = JSON.parse(providerState) as Record<string, unknown>;
    return normalizeProviderValue(parsed.terminalProviderSessionId);
  } catch {
    return undefined;
  }
}

export function extractTerminalProviderSessionActivation(
  providerState: string | null | undefined,
): TerminalProviderSessionActivation | undefined {
  if (!providerState) return undefined;
  try {
    const activation = (JSON.parse(providerState) as Record<string, unknown>)
      .terminalProviderSessionActivation;
    return activation === 'active' || activation === 'background' ? activation : undefined;
  } catch {
    return undefined;
  }
}

export function resolveTerminalProviderSessionReference(
  tesseraSessionId: string,
  providerState: string | null | undefined,
): {
  providerSessionId: string;
  nativeFork: boolean;
  activation?: TerminalProviderSessionActivation;
} {
  const nativeForkSessionId = extractNativeForkProviderSessionId(providerState);
  const activation = extractTerminalProviderSessionActivation(providerState);
  return nativeForkSessionId
    ? {
        providerSessionId: nativeForkSessionId,
        nativeFork: true,
        ...(activation ? { activation } : {}),
      }
    : { providerSessionId: tesseraSessionId, nativeFork: false };
}

export function buildTerminalProviderState(
  identity: TerminalProviderSessionIdentity,
  activation?: TerminalProviderSessionActivation,
): string {
  const state: Record<string, unknown> = {
    kind: 'terminal',
    launched: true,
    terminalProviderSessionId: identity.providerSessionId,
  };
  if (activation) state.terminalProviderSessionActivation = activation;
  if (identity.providerId === 'codex') state.codexSessionId = identity.providerSessionId;
  if (identity.providerId === 'opencode') state.opencodeTerminalSessionId = identity.providerSessionId;
  return JSON.stringify(state);
}
