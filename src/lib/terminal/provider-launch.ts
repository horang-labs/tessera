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
 * 클라 argv 불신. {providerId, sessionId, resume, ...} 만 받아 서버가 최소 argv 전량 조립.
 *  - claude: hooks는 --settings 인라인 주입.
 *  - codex : hooks는 argv가 아니라 CODEX_HOME/hooks.json(오버레이)로 주입되므로 argv엔 없다.
 *            trust는 --dangerously-bypass-hook-trust(글로벌 플래그)로 통과 —
 *            hooks.json은 서버가 소유한 고정 loopback curl이라 인젝션 표면이 없다.
 *            (approvals/sandbox는 절대 우회하지 않는다: --dangerously-bypass-approvals-and-sandbox 미사용.)
 */
export function buildProviderTerminalLaunch(input: ProviderTerminalLaunchInput): ProviderTerminalLaunch {
  if (input.providerId === 'claude-code') {
    if (!input.settingsJson) throw new Error('claude terminal launch requires settingsJson');
    return {
      command: 'claude',
      args: [input.resume ? '--resume' : '--session-id', input.sessionId, '--settings', input.settingsJson],
    };
  }

  if (input.providerId === 'codex') {
    // 글로벌 플래그라 subcommand 앞/뒤 어디든 허용(0.144.1 확인). 신규는 세션식별 인자 없음
    // (codex가 rollout id 자체 발급). resume는 이전 훅에서 캡처한 codexResumeId 필요.
    if (input.resume && input.codexResumeId) {
      return { command: 'codex', args: ['resume', input.codexResumeId, '--dangerously-bypass-hook-trust'] };
    }
    return { command: 'codex', args: ['--dangerously-bypass-hook-trust'] };
  }

  if (input.providerId === 'opencode') {
    const args: string[] = [];
    if (input.resume && input.opencodeResumeId) {
      args.push('--session', input.opencodeResumeId);
    }
    return { command: 'opencode', args };
  }

  throw new Error(`Terminal launch not supported for provider: ${input.providerId}`);
}
