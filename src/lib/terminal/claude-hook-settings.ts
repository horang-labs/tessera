import { buildHookCommand, type HookCommandStyle } from './hook-command';

/**
 * PTY claude에 --settings 로 넘길 hooks 설정(JSON 문자열)을 만든다.
 * 이 객체는 오직 이 invocation에만 적용되며 ~/.claude/settings.json 을 건드리지 않는다.
 *
 * 커맨드 문자열·스타일 규칙은 hook-command.ts 참고 (posix 이중 curl / win32 cmd).
 * timeout 10초: WSL NAT에서 curl.exe 폴백(connect 3 + max 5)이 최악의 경우
 * 5초를 넘길 수 있어 구 값(5초)이 폴백을 중간에 죽이는 일을 막는다.
 */
function lifecycleHook(command: string) {
  return [{ hooks: [{ type: 'command', timeout: 10, command }] }];
}

/** 특정 도구에만 발화하는 tool hook. matcher로 좁혀 매 도구 curl 부하를 피한다. */
function toolHook(matcher: string, command: string) {
  return [{ matcher, hooks: [{ type: 'command', timeout: 10, command }] }];
}

export function buildClaudeHookSettings(style: HookCommandStyle = 'posix'): Record<string, unknown> {
  const command = buildHookCommand(style);
  return {
    hooks: {
      SessionStart: lifecycleHook(command),
      // UserPromptSubmit: 사용자 프롬프트를 session-history에 기록해 터미널 세션에서도
      // AI 자동 타이틀이 되게 한다(codex는 이미 등록됨).
      UserPromptSubmit: lifecycleHook(command),
      Stop: lifecycleHook(command),
      // 일부 빌드는 API/모델 에러 뒤 정상 Stop을 건너뛰고 StopFailure를 낸다.
      // 등록하지 않으면 그 턴의 스피너가 영영 돌아 갇힌다. 오래된 Claude 빌드는
      // 등록되지 않은 이벤트명을 무시하므로 추가는 안전하다.
      StopFailure: lifecycleHook(command),
      // Claude의 lead turn이 먼저 끝나도 background child가 계속 실행될 수 있다.
      // child/team lifecycle을 받아 terminal 상태를 완료로 조기 전환하지 않게 한다.
      SubagentStart: lifecycleHook(command),
      SubagentStop: lifecycleHook(command),
      TeammateIdle: lifecycleHook(command),
      // 모든 도구의 PreToolUse/PostToolUse를 받는다(Orca와 동일). 핵심 목적은
      // 백그라운드 셸 작업(빌드 등)이 끝나 Claude가 자동으로 깨어난 "재기동 턴"의
      // 감지다 — 그 턴에는 UserPromptSubmit이 없어서 도구 이벤트가 유일한 활동
      // 신호다. AskUserQuestion의 input_required 분류는 서버가 tool_name으로
      // 판별한다(ask-user-question-status.ts).
      PreToolUse: toolHook('*', command),
      PostToolUse: toolHook('*', command),
    },
  };
}

export function buildClaudeHookSettingsJson(style: HookCommandStyle = 'posix'): string {
  return JSON.stringify(buildClaudeHookSettings(style));
}
