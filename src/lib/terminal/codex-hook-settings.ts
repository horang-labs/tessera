import { HOOK_CURL } from './claude-hook-settings';

export const CODEX_HOOK_EVENT_LABEL = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
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
 * HOOK_CURL·엔드포인트(/__tessera/hook)·폼바디는 claude와 100% 동일 — 유일한 차이는
 * argv --settings가 아니라 CODEX_HOME/hooks.json 파일로 주입한다는 점.
 * 스크립트는 stdout을 오염시키지 않고 항상 성공 종료(|| true)하는 순수 lifecycle observer다.
 */
function group(): CodexHookGroup[] {
  return [{ hooks: [{ type: 'command', timeout: 5, command: HOOK_CURL }] }];
}

export function buildCodexHookSettings(): CodexHookSettings {
  const hooks = {} as CodexHookSettings['hooks'];
  for (const event of Object.keys(CODEX_HOOK_EVENT_LABEL) as CodexHookEventName[]) {
    hooks[event] = group();
  }
  return { hooks };
}

export function buildCodexHookSettingsJson(): string {
  return JSON.stringify(buildCodexHookSettings(), null, 2);
}
