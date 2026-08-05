export interface ProviderTerminalLaunchInput {
  providerId: string;       // 'claude-code' | 'codex' | 'opencode'
  sessionId: string;        // claude provider id (new sessions use Tessera id). codex는 argv에 안 씀.
  resume: boolean;          // claude: --resume vs --session-id / codex: resume 유무
  settingsJson?: string;    // claude 전용: buildClaudeHookSettingsJson()
  codexResumeId?: string;   // codex 전용: 캡처한 rollout session_id (codex resume <id>)
  opencodeResumeId?: string;
  providerSessionActivation?: 'active' | 'background';
  initialPrompt?: string;
  claudePluginDir?: string;
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
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

function buildClaudeSettingsJson(
  settingsJson: string,
  reasoningEffort: string | null | undefined,
): string {
  if (!reasoningEffort || reasoningEffort === 'auto' || reasoningEffort === 'max') {
    return settingsJson;
  }
  const settings = JSON.parse(settingsJson) as unknown;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('claude terminal launch requires object settings');
  }
  const merged = settings as Record<string, unknown>;
  if (reasoningEffort === 'ultracode') {
    merged.ultracode = true;
  } else {
    merged.effortLevel = reasoningEffort;
  }
  return JSON.stringify(merged);
}

function buildCodexSelectionArgs(input: ProviderTerminalLaunchInput): string[] {
  const args: string[] = [];
  if (input.model) args.push('--model', input.model);
  if (input.reasoningEffort && input.reasoningEffort !== 'auto') {
    args.push('--config', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`);
  }
  if (input.serviceTier) {
    args.push('--config', `service_tier=${JSON.stringify(input.serviceTier)}`);
  }
  return args;
}

/**
 * 클라 argv 불신. {providerId, sessionId, resume, ...} 만 받아 서버가 최소 argv 전량 조립.
 *  - claude: hooks는 --settings 인라인 주입.
 *  - codex : hooks는 argv가 아니라 CODEX_HOME/hooks.json(오버레이)로 주입되므로 argv엔 없다.
 *            Tessera 훅의 trust hash도 오버레이 config.toml에 함께 기록한다.
 *            (approvals/sandbox는 절대 우회하지 않는다: --dangerously-bypass-approvals-and-sandbox 미사용.)
 */
export function buildProviderTerminalLaunch(input: ProviderTerminalLaunchInput): ProviderTerminalLaunch {
  if (input.initialPrompt !== undefined && input.resume) {
    throw new Error('initial prompt requires a fresh provider conversation');
  }

  if (input.providerId === 'claude-code') {
    if (!input.settingsJson) throw new Error('claude terminal launch requires settingsJson');
    if (input.providerSessionActivation === 'background') {
      if (input.initialPrompt !== undefined) {
        throw new Error('initial prompt cannot attach to a background provider session');
      }
      return {
        command: TERMINAL_PROVIDER_COMMANDS['claude-code'],
        // The daemon inherited hooks when `/fork` created it. Claude's attach
        // subcommand ignores trailing global flags and misparses leading ones.
        args: ['attach', input.sessionId.slice(0, 8)],
      };
    }
    return {
      command: TERMINAL_PROVIDER_COMMANDS['claude-code'],
      args: [
        input.resume ? '--resume' : '--session-id',
        input.sessionId,
        ...(input.model ? ['--model', input.model] : []),
        ...(input.reasoningEffort === 'max' ? ['--effort', 'max'] : []),
        '--settings',
        buildClaudeSettingsJson(input.settingsJson, input.reasoningEffort),
        ...(input.claudePluginDir ? ['--plugin-dir', input.claudePluginDir] : []),
        ...(input.initialPrompt !== undefined ? ['--', input.initialPrompt] : []),
      ],
    };
  }

  if (input.providerId === 'codex') {
    const selectionArgs = buildCodexSelectionArgs(input);
    // 신규는 세션식별 인자 없음(codex가 rollout id 자체 발급).
    // resume는 이전 훅에서 캡처한 codexResumeId 필요.
    if (input.resume && input.codexResumeId) {
      return {
        command: TERMINAL_PROVIDER_COMMANDS.codex,
        args: [...selectionArgs, 'resume', input.codexResumeId],
      };
    }
    return {
      command: TERMINAL_PROVIDER_COMMANDS.codex,
      args: [
        ...selectionArgs,
        ...(input.initialPrompt !== undefined ? ['--', input.initialPrompt] : []),
      ],
    };
  }

  if (input.providerId === 'opencode') {
    const args: string[] = [];
    if (input.resume && input.opencodeResumeId) {
      args.push('--session', input.opencodeResumeId);
    }
    if (input.initialPrompt !== undefined) {
      args.push('--prompt', input.initialPrompt);
    }
    return { command: TERMINAL_PROVIDER_COMMANDS.opencode, args };
  }

  throw new Error(`Terminal launch not supported for provider: ${input.providerId}`);
}
