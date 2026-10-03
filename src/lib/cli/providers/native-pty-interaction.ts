import type { CliProvider } from './provider-contract';
import { observeNativePrompt, observesNativePaste } from './native-pty-prompt';
import { readNativeApprovalRequest } from './native-pty-approval';

/** Version-specific PTY evidence remains behind the provider interface, separate from app-server approvals. */
export function createNativePtyInteraction(provider: 'codex' | 'claude-code'): NonNullable<CliProvider['nativeTerminalInteraction']> {
  return {
    observePrompt: (identity, version, frame) => identity.provider === provider ? observeNativePrompt(identity, version, frame)
      : { kind: 'unknown', reason: 'native-provider-mismatch' },
    observesPaste: (prompt, frame) => observesNativePaste(provider, prompt, frame),
    readApproval: (identity, payload) => identity.provider === provider ? readNativeApprovalRequest(identity, payload) : null,
  };
}
