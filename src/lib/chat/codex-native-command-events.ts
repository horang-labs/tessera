export const CODEX_NATIVE_COMMAND_EVENT = 'tessera:codex-native-command';

export type CodexNativeUiAction = 'model' | 'permissions' | 'plan' | 'rename';

export interface CodexNativeCommandEventDetail {
  sessionId: string;
  action: CodexNativeUiAction;
}

export function dispatchCodexNativeUiAction(
  sessionId: string,
  action: CodexNativeUiAction,
): void {
  window.dispatchEvent(new CustomEvent<CodexNativeCommandEventDetail>(
    CODEX_NATIVE_COMMAND_EVENT,
    { detail: { sessionId, action } },
  ));
}
