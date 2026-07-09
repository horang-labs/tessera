/**
 * 헤드리스 stream-json(`initialize.commands`)에 노출되지 않아 Tessera 세션에서
 * 직접 처리할 수 없는 Claude Code 슬래시 명령들 — 선택 시 터미널 fallback으로
 * 라우팅해 실제 `claude`에서 실행한다.
 *
 * 이 목록은 "터미널로 보낼 후보"의 **보조** 기준이다. 1순위는 세션이 실제 보고한
 * 명령(store commands = initialize.commands)이며, shouldRouteToTerminalFallback()이
 * store에 있는 명령은 무조건 제외한다. 따라서 claude 버전이 올라 어떤 명령이
 * 헤드리스로 옮겨가면(예: 2.1.202의 config/recap/agents가 initialize.commands에 노출)
 * store에 잡혀 자동으로 이 라우팅에서 빠진다 — 하드코딩과 세션 실측이 어긋나지 않는다.
 *
 * 목록에서 뺀 것:
 *   - 헤드리스로 이동해 store가 처리(2.1.202+): agents, config, recap
 *   - 현재-대화-대상이라 새 터미널 세션에선 무의미(빈 히스토리): export, copy,
 *     resume, rewind, status, focus, plan
 *
 * 절대 넣지 말 것: /model /effort /usage /fast /rename 등은 control-request이거나
 * Tessera 자체 빌트인(/fast, /goal)이라 이미 네이티브 지원된다 — 넣으면 터미널로
 * 잘못 분기된다.
 *
 * 주의: 유지 항목이 전부 Ink 위젯 전용은 아니다(diff/help/skills 등 포함). 공통
 * 기준은 "현재 claude 빌드의 initialize.commands에 안 나온다"는 점이며, description은
 * 피커 표시용으로 대부분 claude 바이너리에서 추출했다.
 */

export interface TuiOnlyCommand {
  name: string;
  description: string;
}

// canonical 이름(별칭 해석 후) 기준 TUI 전용 명령 목록.
const TUI_ONLY_COMMANDS: readonly TuiOnlyCommand[] = [
  // 설정 · 인증
  { name: 'login', description: 'Sign in to your Anthropic account' },
  { name: 'logout', description: 'Sign out from your Anthropic account' },
  { name: 'permissions', description: 'Manage tool permissions' },
  { name: 'terminal-setup', description: 'Install Shift+Enter key binding for newlines' },
  { name: 'theme', description: 'Change the theme' },
  { name: 'privacy-settings', description: 'View and update your privacy settings' },
  { name: 'keybindings', description: 'Open your keyboard shortcuts file' },
  { name: 'statusline', description: 'Set up a custom status line' },
  // 관리 (MCP · 훅 · 메모리 · 플러그인)
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'memory', description: 'Open a memory file in your editor' },
  { name: 'hooks', description: 'View hook configurations for tool events' },
  { name: 'plugin', description: 'Manage plugins and marketplaces' },
  { name: 'reload-plugins', description: 'Activate pending plugin changes in the current session' },
  // 환경 · 통합
  { name: 'add-dir', description: 'Add a new working directory' },
  { name: 'ide', description: 'Manage IDE integrations and show status' },
  { name: 'install-github-app', description: 'Set up Claude GitHub Actions for a repository' },
  // 진단 · 도움말 · 도구
  { name: 'diff', description: 'View uncommitted changes and per-turn diffs' },
  { name: 'doctor', description: 'Diagnose and verify your installation' },
  { name: 'help', description: 'Show help and available commands' },
  { name: 'skills', description: 'List available skills' },
  { name: 'feedback', description: 'Submit feedback, report a bug, or share your conversation' },
  { name: 'release-notes', description: 'View release notes' },
  // 풀스크린 / 렌더러 전용 위젯
  { name: 'tui', description: 'Set the terminal UI renderer (default | fullscreen)' },
  { name: 'scroll-speed', description: 'Adjust mouse wheel scroll speed' },
  { name: 'powerup', description: 'Interactive lessons with animated demos' },
  { name: 'workflows', description: 'View running workflows' },
];

const TUI_ONLY_COMMAND_SET = new Set(TUI_ONLY_COMMANDS.map((c) => c.name));

// 별칭 → canonical (claude 바이너리 aliases 필드 기준). canonical이 위 목록에 남아
// 있는 별칭만 유지한다(삭제된 resume/rewind 관련 continue/checkpoint/undo는 제거).
const SLASH_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  'allowed-tools': 'permissions',
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

/** 슬래시 명령 이름을 canonical(별칭 해석 + 소문자)로 정규화한다. */
function canonicalSlashCommandName(rawName: string): string {
  const lower = rawName.toLowerCase();
  return SLASH_COMMAND_ALIASES[lower] ?? lower;
}

/**
 * 입력이 터미널 fallback 대상인지 판정한다.
 *  - 1순위: 세션이 실제 보고한 명령(sessionCommandNames = store commands, headless
 *    지원)에 있으면 절대 터미널로 보내지 않는다 → 버전 드리프트 자동 해소.
 *  - 2순위: store에 없고, 축소된 TUI 전용 목록에 canonical이 있으면 터미널.
 * sessionCommandNames는 소문자 이름 집합을 기대한다(호출부에서 정규화).
 */
export function shouldRouteToTerminalFallback(
  input: string,
  sessionCommandNames?: ReadonlySet<string>,
): boolean {
  const name = extractSlashCommandName(input);
  if (name === null) return false;
  const lower = name.toLowerCase();
  const canonical = canonicalSlashCommandName(name);
  // 세션이 headless로 지원한다고 보고한 명령이면(별칭/실이름 어느 쪽이든) 제외.
  if (sessionCommandNames?.has(lower) || sessionCommandNames?.has(canonical)) {
    return false;
  }
  return TUI_ONLY_COMMAND_SET.has(canonical);
}
