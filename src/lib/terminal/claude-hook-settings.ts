/**
 * PTY claude에 --settings 로 넘길 hooks 설정(JSON 문자열)을 만든다.
 * 이 객체는 오직 이 invocation에만 적용되며 ~/.claude/settings.json 을 건드리지 않는다.
 *
 * command 안의 $TESSERA_HOOK_PORT / $TESSERA_SESSION_ID / $TESSERA_PANE_TOKEN 은
 * claude가 훅을 /bin/sh -c 로 실행할 때 그 프로세스 env(=PTY env)에서 확장된다.
 * 셸 인젝션 표면 없음: 값은 전부 서버가 주입한 env 참조뿐이다.
 */
export const HOOK_CURL =
  'curl -sS -m 2 -X POST '
  + '"http://127.0.0.1:$TESSERA_HOOK_PORT/__tessera/hook?session=$TESSERA_SESSION_ID" '
  + '-H "X-Tessera-Pane-Token: $TESSERA_PANE_TOKEN" '
  + '--data-binary @- >/dev/null 2>&1 || true';

function lifecycleHook() {
  return [{ hooks: [{ type: 'command', timeout: 5, command: HOOK_CURL }] }];
}

export function buildClaudeHookSettings(): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: lifecycleHook(),
      // UserPromptSubmit: 사용자 프롬프트를 session-history에 기록해 터미널 세션에서도
      // AI 자동 타이틀이 되게 한다(codex는 이미 등록됨).
      UserPromptSubmit: lifecycleHook(),
      Stop: lifecycleHook(),
      // Claude의 lead turn이 먼저 끝나도 background child가 계속 실행될 수 있다.
      // child/team lifecycle을 받아 terminal 상태를 완료로 조기 전환하지 않게 한다.
      SubagentStart: lifecycleHook(),
      SubagentStop: lifecycleHook(),
      TeammateIdle: lifecycleHook(),
    },
  };
}

export function buildClaudeHookSettingsJson(): string {
  return JSON.stringify(buildClaudeHookSettings());
}
