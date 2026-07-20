export interface ProviderTerminalLaunchInput {
  providerId: string;       // 'claude-code' | 'codex' | 'opencode'
  sessionId: string;        // tessera uuid (claude --session-id). codex는 argv에 안 씀.
  resume: boolean;          // claude: --resume vs --session-id / codex: resume 유무
  settingsJson?: string;    // claude 전용: buildClaudeHookSettingsJson()
  codexResumeId?: string;   // codex 전용: 캡처한 rollout session_id (codex resume <id>)
  opencodeResumeId?: string;
}

export interface ProviderTerminalLaunch {
  command: string;   // 서버가 검증·선택한 provider executable
  args: string[];    // 서버가 조립한 provider argv
}

/**
 * PTY 셸에 넘기는 프로바이더별 실행 파일(bare command).
 * PATH 해석은 로그인 셸에 위임하므로 절대경로가 아니다.
 * provider-detection.ts가 같은 값을 로그인 셸에서 `command -v`로 프로브하므로
 * 여기 값이 바뀌면 감지도 자동으로 따라간다 (감지=실행 일치).
 */
export const TERMINAL_PROVIDER_COMMANDS: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * 클라 argv 불신. {providerId, sessionId, resume, ...} 만 받아 서버가 최소 argv 전량 조립.
 *  - claude: hooks는 --settings 인라인 주입.
 *  - codex : hooks는 argv가 아니라 CODEX_HOME/hooks.json(오버레이)로 주입되므로 argv엔 없다.
 *            Tessera 훅의 trust hash도 오버레이 config.toml에 함께 기록한다.
 *            (approvals/sandbox는 절대 우회하지 않는다: --dangerously-bypass-approvals-and-sandbox 미사용.)
 */
export function buildProviderTerminalLaunch(input: ProviderTerminalLaunchInput): ProviderTerminalLaunch {
  if (input.providerId === 'claude-code') {
    if (!input.settingsJson) throw new Error('claude terminal launch requires settingsJson');
    return {
      command: TERMINAL_PROVIDER_COMMANDS['claude-code'],
      args: [input.resume ? '--resume' : '--session-id', input.sessionId, '--settings', input.settingsJson],
    };
  }

  if (input.providerId === 'codex') {
    // 신규는 세션식별 인자 없음(codex가 rollout id 자체 발급).
    // resume는 이전 훅에서 캡처한 codexResumeId 필요.
    if (input.resume && input.codexResumeId) {
      return { command: TERMINAL_PROVIDER_COMMANDS.codex, args: ['resume', input.codexResumeId] };
    }
    return { command: TERMINAL_PROVIDER_COMMANDS.codex, args: [] };
  }

  if (input.providerId === 'opencode') {
    const args: string[] = [];
    if (input.resume && input.opencodeResumeId) {
      args.push('--session', input.opencodeResumeId);
    }
    return { command: TERMINAL_PROVIDER_COMMANDS.opencode, args };
  }

  throw new Error(`Terminal launch not supported for provider: ${input.providerId}`);
}
