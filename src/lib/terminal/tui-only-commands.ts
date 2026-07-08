/**
 * Claude Code CLI 슬래시 명령 중 Ink TUI(local-jsx) 위젯이 필요해
 * 헤드리스 stream-json 모드에서 동작 불가능한 명령들.
 *
 * 출처: claude v2.1.168 네이티브 바이너리 분석.
 *   - type: 'local-jsx' (requires:{ink:!0}) → 헤드리스 필터(UYH)에서 무조건 제외
 *   - type: 'local' & supportsNonInteractive:false → 명시적 차단
 * 이들은 stream-json initialize.commands 목록에 절대 노출되지 않으므로
 * Tessera에서 입력 시 처리할 방법이 없다 → 터미널 fallback으로 라우팅하고,
 * 슬래시 피커에도 함께 노출해 사용자가 선택할 수 있게 한다.
 *
 * 주의(중요): /model /effort /usage /fast /rename 등은 commands 목록에는 없지만
 * thinClientDispatch:control-request 이거나 Tessera 자체 빌트인(/fast,/goal)이라
 * 세션 컨트롤 UI / control 프로토콜로 이미 네이티브 지원된다.
 * 절대 이 목록에 넣지 말 것 — 넣으면 터미널 fallback으로 잘못 분기된다.
 *
 * description은 피커 표시용이며 대부분 바이너리에서 추출했다.
 */

export interface TuiOnlyCommand {
  name: string;
  description: string;
}

// canonical 이름(별칭 해석 후) 기준 TUI 전용 명령 목록.
const TUI_ONLY_COMMANDS: readonly TuiOnlyCommand[] = [
  // 설정 · 인증 · 관리
  { name: 'config', description: 'Open settings' },
  { name: 'login', description: 'Sign in to your Anthropic account' },
  { name: 'logout', description: 'Sign out from your Anthropic account' },
  { name: 'permissions', description: 'Manage tool permissions' },
  { name: 'terminal-setup', description: 'Install Shift+Enter key binding for newlines' },
  { name: 'theme', description: 'Change the theme' },
  { name: 'privacy-settings', description: 'View and update your privacy settings' },
  { name: 'keybindings', description: 'Open your keyboard shortcuts file' },
  { name: 'statusline', description: 'Set up a custom status line' },
  // 세션 · 컨텍스트 탐색 (TUI 피커/뷰 필요)
  { name: 'resume', description: 'Resume a previous conversation' },
  { name: 'agents', description: 'Manage agent configurations' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'memory', description: 'Open a memory file in your editor' },
  { name: 'plan', description: 'Enable plan mode or view the current session plan' },
  { name: 'diff', description: 'View uncommitted changes and per-turn diffs' },
  { name: 'status', description: 'Show session status and diagnostics' },
  { name: 'export', description: 'Export the current conversation to a file or clipboard' },
  { name: 'copy', description: 'Copy the last response to the clipboard' },
  { name: 'rewind', description: 'Rewind the conversation to a checkpoint' },
  { name: 'recap', description: 'Generate a one-line session recap now' },
  // 진단 · 도움말 · 확장
  { name: 'doctor', description: 'Diagnose and verify your installation' },
  { name: 'help', description: 'Show help and available commands' },
  { name: 'hooks', description: 'View hook configurations for tool events' },
  { name: 'skills', description: 'List available skills' },
  { name: 'plugin', description: 'Manage plugins and marketplaces' },
  { name: 'reload-plugins', description: 'Activate pending plugin changes in the current session' },
  { name: 'ide', description: 'Manage IDE integrations and show status' },
  { name: 'add-dir', description: 'Add a new working directory' },
  { name: 'install-github-app', description: 'Set up Claude GitHub Actions for a repository' },
  { name: 'feedback', description: 'Submit feedback, report a bug, or share your conversation' },
  { name: 'release-notes', description: 'View release notes' },
  // 풀스크린/렌더러 전용 위젯 (v2.1.168 바이너리에서 type:local-jsx, requires:{ink:!0} 확인)
  { name: 'tui', description: 'Set the terminal UI renderer (default | fullscreen)' },
  { name: 'scroll-speed', description: 'Adjust mouse wheel scroll speed' },
  { name: 'focus', description: 'Toggle focus view: just your prompt, summary, and response' },
  { name: 'powerup', description: 'Interactive lessons with animated demos' },
  { name: 'workflows', description: 'View running workflows' },
];

const TUI_ONLY_COMMAND_SET = new Set(TUI_ONLY_COMMANDS.map((c) => c.name));

// 별칭 → canonical (claude 바이너리 aliases 필드 기준)
const SLASH_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  continue: 'resume',
  'allowed-tools': 'permissions',
  checkpoint: 'rewind',
  undo: 'rewind',
  plugins: 'plugin',
  marketplace: 'plugin',
};

/** 피커에 노출할 TUI 전용 명령 목록(설명 포함). canonical 이름만 — 별칭은 제외. */
export function getTuiOnlySlashCommands(): readonly TuiOnlyCommand[] {
  return TUI_ONLY_COMMANDS;
}

/**
 * 입력 문자열에서 슬래시 명령 이름을 추출한다.
 * 예: "/config" → "config", "/diff HEAD~1" → "diff", "hello" → null
 */
export function extractSlashCommandName(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return null;
  // 명령 이름의 끝은 공백뿐 아니라 개행/탭 등 모든 공백류로 판정한다(예: "/config\nfoo").
  const delimIdx = trimmed.search(/\s/);
  const raw = delimIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, delimIdx);
  return raw.length > 0 ? raw : null;
}

/**
 * 주어진 슬래시 명령 이름이 헤드리스 미지원(TUI 전용)이라 터미널 fallback이
 * 필요한지 판정한다. 별칭을 canonical로 해석한 뒤 화이트리스트와 비교한다.
 */
export function isTuiOnlySlashCommand(rawName: string): boolean {
  const lower = rawName.toLowerCase();
  const canonical = SLASH_COMMAND_ALIASES[lower] ?? lower;
  return TUI_ONLY_COMMAND_SET.has(canonical);
}

/**
 * 입력이 터미널 fallback 대상인지 한 번에 판정한다.
 * (슬래시로 시작 + 추출된 명령 이름이 TUI 전용 화이트리스트에 매칭)
 */
export function shouldRouteToTerminalFallback(input: string): boolean {
  const name = extractSlashCommandName(input);
  return name !== null && isTuiOnlySlashCommand(name);
}
