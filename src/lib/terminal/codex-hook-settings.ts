import { buildHookCommand, type HookCommandStyle } from './hook-command';
import { buildNativeApprovalHookCommand } from './native-approval-hook';

export const CODEX_HOOK_EVENT_LABEL = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
} as const;

export type CodexHookEventName = keyof typeof CODEX_HOOK_EVENT_LABEL;

export interface CodexHookCommand {
  type: 'command';
  timeout?: number;
  command: string;
  async?: boolean;
  statusMessage?: string;
}

export interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookCommand[];
}

export interface CodexHookSettings {
  hooks: Record<CodexHookEventName, CodexHookGroup[]>;
}

/**
 * codex CODEX_HOME/hooks.json 에 쓸 상태 훅 정의.
 * 스키마: { hooks: { <Event>: [ { hooks: [ { type, command, timeout } ] } ] } }.
 * claude와 달리 matcher 키 없음(codex managed 정의는 matcher 미부착).
 * Lifecycle uses the shared observer. PermissionRequest alone installs the scoped
 * once-only response bridge; unmanaged/Heartbeat requests keep empty stdout/manual approval.
 * Codex receives this through CODEX_HOME/hooks.json rather than Claude's --settings.
 */
function group(command: string): CodexHookGroup[] {
  return [{ hooks: [{ type: 'command', timeout: 10, command }] }];
}

export function buildCodexHookSettings(style: HookCommandStyle = 'posix'): CodexHookSettings {
  const command = buildHookCommand(style);
  const hooks = {} as CodexHookSettings['hooks'];
  for (const event of Object.keys(CODEX_HOOK_EVENT_LABEL) as CodexHookEventName[]) {
    hooks[event] = group(command);
  }
  hooks.PermissionRequest = [{ hooks: [{ type: 'command', timeout: 120, command: buildNativeApprovalHookCommand(style, 'codex') }] }];
  return { hooks };
}

export function buildCodexHookSettingsJson(style: HookCommandStyle = 'posix'): string {
  return JSON.stringify(buildCodexHookSettings(style), null, 2);
}
