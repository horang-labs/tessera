import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getProject, getVisibleProjects } from '@/lib/db/projects';
import { getSession } from '@/lib/db/sessions';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import type {
  TerminalCwdResolution,
  TerminalLaunchSpec,
  TerminalResolvedShell,
  TerminalShellKind,
} from './types';

export function resolveTerminalCwd(candidate?: string | null): string {
  if (candidate) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Fall through to home directory.
    }
  }

  return os.homedir();
}

let cachedWindowsHostedWslRoot: string | null | undefined;

function resolveExistingDirectory(candidate: string, allowedRoots: string[] = []): string | null {
  for (const candidatePath of buildDirectoryResolutionCandidates(candidate, allowedRoots)) {
    const existingDirectory = resolveExistingDirectoryCandidate(candidatePath);
    if (existingDirectory) return existingDirectory;
  }

  return null;
}

function resolveExistingDirectoryCandidate(candidate: string): string | null {
  try {
    const resolved = isWindowsStylePath(candidate)
      ? path.win32.resolve(candidate)
      : path.resolve(candidate);
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function normalizeForComparison(value: string): string {
  const wslPath = toWslPath(value);
  if (wslPath) {
    return path.posix.resolve(wslPath);
  }

  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrChildPath(candidate: string, allowedRoot: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(allowedRoot);
  if (normalizedCandidate === normalizedRoot) return true;
  const pathModule = normalizedCandidate.startsWith('/') && normalizedRoot.startsWith('/')
    ? path.posix
    : path;
  const relative = pathModule.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative) && !relative.startsWith('..') && !pathModule.isAbsolute(relative);
}

function addAllowedRoot(allowedRoots: string[], seenRoots: Set<string>, root?: string | null): void {
  const normalizedRoot = root?.trim();
  if (!normalizedRoot || seenRoots.has(normalizedRoot)) return;
  seenRoots.add(normalizedRoot);
  allowedRoots.push(normalizedRoot);
}

function resolveFirstExistingAllowedRoot(allowedRoots: string[]): string | null {
  for (const root of allowedRoots) {
    const existingRoot = resolveExistingDirectory(root, allowedRoots);
    if (existingRoot) return existingRoot;
  }

  return null;
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[a-zA-Z]:$/.test(value);
}

function isWindowsHostedWslPath(value: string): boolean {
  return /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(value)
    || /^\/\/(?:wsl\.localhost|wsl\$)\//i.test(value);
}

function isWindowsStylePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
    || isWindowsHostedWslPath(value)
    || value.startsWith('\\\\')
    || value.startsWith('//');
}

function buildDirectoryResolutionCandidates(candidate: string, allowedRoots: string[]): string[] {
  const candidates = [candidate];
  if (getRuntimePlatform() !== 'win32') {
    return candidates;
  }

  if (candidate.startsWith('//')) {
    candidates.push(candidate.replace(/\//g, '\\'));
  }

  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    for (const root of getWindowsHostedWslReferenceRoots(allowedRoots)) {
      candidates.push(toWindowsHostedWslPath(candidate, root));
    }
  }

  return [...new Set(candidates)];
}

function getWindowsHostedWslReferenceRoots(values: string[]): string[] {
  const roots = new Set<string>();
  for (const value of values) {
    const root = getWindowsHostedWslRoot(value);
    if (root) roots.add(root);
  }

  const defaultRoot = getWindowsHostedWslDefaultRoot();
  if (defaultRoot) roots.add(defaultRoot);

  return [...roots];
}

function getWindowsHostedWslRoot(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\//g, '\\');
  if (!normalized) return null;
  const match = normalized.match(/^(\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+)(?:\\|$)/i);
  return match ? path.win32.normalize(match[1]) : null;
}

function getWindowsHostedWslDefaultRoot(): string | null {
  if (getRuntimePlatform() !== 'win32') return null;
  if (cachedWindowsHostedWslRoot !== undefined) {
    return cachedWindowsHostedWslRoot;
  }

  const envDistro = process.env.WSL_DISTRO_NAME?.trim();
  if (envDistro) {
    cachedWindowsHostedWslRoot = `\\\\wsl.localhost\\${envDistro}`;
    return cachedWindowsHostedWslRoot;
  }

  try {
    const distro = execFileSync(
      'wsl.exe',
      ['-e', 'sh', '-c', 'printf "%s" "${WSL_DISTRO_NAME:-}"'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
    ).trim();
    cachedWindowsHostedWslRoot = distro ? `\\\\wsl.localhost\\${distro}` : null;
  } catch {
    cachedWindowsHostedWslRoot = null;
  }

  return cachedWindowsHostedWslRoot;
}

function toWindowsHostedWslPath(displayPath: string, wslRoot: string): string {
  const normalizedDisplayPath = path.posix.normalize(displayPath);
  if (normalizedDisplayPath === '/') return wslRoot;
  return path.win32.join(
    wslRoot,
    ...normalizedDisplayPath.split('/').filter(Boolean),
  );
}

function toWslPath(value: string): string | null {
  const driveMatch = value.match(/^([a-zA-Z]):[\\/]*(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/[\\/]+/g, '/').replace(/^\/+/, '');
    return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
  }

  const uncMatch = value.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\?(.*)$/i);
  if (uncMatch) {
    const rest = uncMatch[2].replace(/\\/g, '/').replace(/^\/+/, '');
    return rest ? `/${rest}` : '/';
  }

  const slashUncMatch = value.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)\/?(.*)$/i);
  if (slashUncMatch) {
    const rest = slashUncMatch[2].replace(/^\/+/, '');
    return rest ? `/${rest}` : '/';
  }

  if (value.startsWith('/')) {
    return path.posix.normalize(value);
  }

  return null;
}

function resolveWindowsProcessCwd(env: NodeJS.ProcessEnv): string {
  const userProfile = env.USERPROFILE?.trim();
  if (userProfile && isWindowsDrivePath(userProfile)) {
    return path.win32.normalize(userProfile);
  }

  const home = os.homedir();
  if (isWindowsDrivePath(home)) {
    return path.win32.normalize(home);
  }

  const windowsRoot = env.SystemRoot?.trim() || env.windir?.trim();
  if (windowsRoot && isWindowsDrivePath(windowsRoot)) {
    return path.win32.join(windowsRoot, 'System32');
  }

  return 'C:\\';
}

function resolveWindowsNativeTerminalCwd(cwd: string, env: NodeJS.ProcessEnv): string {
  if (isWindowsHostedWslPath(cwd)) {
    return resolveWindowsProcessCwd(env);
  }

  return cwd;
}

function quoteBashArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPosixCommand(program: string, args: string[]): string {
  return [program, ...args].map(quoteBashArg).join(' ');
}

/**
 * PowerShell 인용은 두 단계를 통과해야 한다: (1) PS 파서(작은따옴표), (2) 네이티브
 * 명령 인자 전달. powershell.exe(항상 5.1)의 NativeCommandParameterBinder는 공백
 * 포함 인자를 큰따옴표로 감싸면서 내부 큰따옴표를 이스케이프하지 않는다(PS 7.2+의
 * PSNativeCommandArgumentPassing에서만 수정됨) — claude의 --settings JSON처럼
 * 큰따옴표+공백을 함께 가진 인자는 자식 argv가 쪼개진다. 그래서 값 안의 큰따옴표를
 * CommandLineToArgvW 규칙(\" + 직전 백슬래시 배가)으로 선-이스케이프한다. 큰따옴표가
 * 인용부 밖에 놓이는 경우(공백 없는 값)에도 \" 는 리터럴 따옴표로 파싱되므로 안전하다.
 */
function quotePowerShellArg(value: string): string {
  const nativeSafe = value.replace(/(\\*)"/g, (_match, backslashes: string) =>
    `${backslashes}${backslashes}\\"`);
  return `'${nativeSafe.replace(/'/g, "''")}'`;
}

function buildPowerShellCommand(program: string, args: string[]): string {
  return `& ${[program, ...args].map(quotePowerShellArg).join(' ')}`;
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/(["^&|<>])/g, '^$1')}"`;
}

function buildCmdCommand(program: string, args: string[]): string {
  return [program, ...args].map(quoteCmdArg).join(' ');
}

function getLaunchArgv(launchSpec?: TerminalLaunchSpec): { program: string; args: string[] } | null {
  const program = launchSpec?.program?.trim();
  if (!program) return null;
  return { program, args: launchSpec?.args ?? [] };
}

function buildWslTerminalScript(cwd: string, launchSpec?: TerminalLaunchSpec): string {
  const lines = [
    `cd -- ${quoteBashArg(cwd)} 2>/dev/null || cd ~`,
    'shell="${SHELL:-}"',
    'if [ -z "$shell" ] || [ ! -x "$shell" ]; then shell="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; fi',
    'if [ -z "$shell" ] || [ ! -x "$shell" ]; then shell="$(command -v bash 2>/dev/null || command -v sh)"; fi',
  ];
  const launch = getLaunchArgv(launchSpec);
  if (launch) {
    // 중요: `wsl.exe -e sh -c`는 non-login·non-interactive 셸이라 ~/.profile·rc가
    // 소싱되지 않아 사용자 로컬 PATH(~/.local/bin, nvm/volta 등)가 없다 → 여기서 claude를
    // 바로 실행하면 'command not found'가 된다. 따라서 login+interactive 셸로 감싸
    // rc/profile를 먼저 소싱한 뒤 실행한다. TUI 종료 후 셸로 떨어지지 않아야
    // 지연된 slash prefill이 우연히 셸 명령으로 해석되지 않는다.
    // $shell은 export해 inner 셸이 재사용한다(inner는 작은따옴표라 바깥에서 전개되지 않음).
    // CODEX_HOME 재단언: 로그인 셸의 profile이 CODEX_HOME을 무조건 export하면
    // WSLENV로 주입한 per-terminal 오버레이가 덮여 codex가 오버레이(훅/trust)를
    // 무시한다. profile 소싱이 끝난 -c 본문에서 원본(TESSERA_CODEX_HOME)으로
    // 되돌린다 — orca의 powershell-osc133-bootstrap(ORCA_CODEX_HOME 복원) 미러.
    const inner =
      'if [ -n "${TESSERA_CODEX_HOME:-}" ]; then CODEX_HOME="$TESSERA_CODEX_HOME"; export CODEX_HOME; fi; '
      + `exec ${buildPosixCommand(launch.program, launch.args)}`;
    lines.push('WSL_LAUNCH_SHELL="$shell"; export WSL_LAUNCH_SHELL');
    lines.push(`exec "$shell" -l -i -c ${quoteBashArg(inner)}`);
  } else {
    lines.push('exec "$shell" -i');
  }
  return lines.join('; ');
}

export function resolveAllowedTerminalCwd(options: {
  cwd?: string | null;
  sessionId?: string | null;
  allowFallback?: boolean;
}): TerminalCwdResolution {
  const requestedCwd = options.cwd?.trim();
  const allowFallback = options.allowFallback !== false;
  const allowedRoots: string[] = [];
  const seenRoots = new Set<string>();

  const session = options.sessionId ? getSession(options.sessionId) : null;
  if (session?.project_id) {
    addAllowedRoot(allowedRoots, seenRoots, getProject(session.project_id)?.decoded_path);
  }

  for (const project of getVisibleProjects()) {
    addAllowedRoot(allowedRoots, seenRoots, project.decoded_path);
  }

  addAllowedRoot(allowedRoots, seenRoots, session?.work_dir);

  if (allowedRoots.length === 0) {
    return { ok: false, message: 'No project is available for terminal startup.' };
  }

  if (!requestedCwd) {
    if (!allowFallback) {
      return { ok: false, message: 'This command requires the session workspace to be available.' };
    }
    const fallbackCwd = resolveFirstExistingAllowedRoot(allowedRoots);
    if (fallbackCwd) {
      return { ok: true, cwd: fallbackCwd };
    }

    return { ok: false, message: 'No registered project directory exists on this server.' };
  }

  const resolvedCandidate = resolveExistingDirectory(requestedCwd, allowedRoots);
  if (!resolvedCandidate) {
    if (!allowFallback) {
      return { ok: false, message: 'The session workspace no longer exists. The command was not opened.' };
    }
    const fallbackCwd = resolveFirstExistingAllowedRoot(allowedRoots);
    if (fallbackCwd) {
      return { ok: true, cwd: fallbackCwd };
    }

    return { ok: false, message: 'Terminal cwd does not exist or is not a directory.' };
  }

  for (const root of allowedRoots) {
    if (isSameOrChildPath(resolvedCandidate, root)) {
      return { ok: true, cwd: resolvedCandidate };
    }
  }

  return {
    ok: false,
    message: 'Terminal cwd must be inside a registered project or active worktree.',
  };
}

/**
 * POSIX PTY가 띄우는 셸과 로그인 플래그.
 * provider-detection.ts가 같은 셸로 `command -v`를 프로브해서
 * 감지 환경과 실행 환경(PATH)을 일치시킨다 — 반드시 공유할 것.
 */
export function resolvePosixTerminalShellCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; loginArgs: string[] } {
  return {
    command: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    loginArgs: platform === 'darwin' ? ['-l'] : [],
  };
}

export function resolveTerminalShell(options: {
  cwd?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  shellKind?: TerminalShellKind;
  launchSpec?: TerminalLaunchSpec;
}): TerminalResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const shellKind = options.shellKind ?? 'default';
  const cwd = resolveTerminalCwd(options.cwd);
  const launch = getLaunchArgv(options.launchSpec);

  if (shellKind === 'wsl' && platform === 'win32') {
    const wslCwd = toWslPath(cwd) ?? '~';
    return {
      command: 'wsl.exe',
      args: ['-e', 'sh', '-c', buildWslTerminalScript(wslCwd, options.launchSpec)],
      cwd: resolveWindowsProcessCwd(env),
      displayCwd: wslCwd,
    };
  }

  if (platform === 'win32') {
    const windowsCwd = resolveWindowsNativeTerminalCwd(cwd, env);
    if (shellKind === 'cmd') {
      return {
        command: 'cmd.exe',
        args: launch ? ['/c', buildCmdCommand(launch.program, launch.args)] : [],
        cwd: windowsCwd,
      };
    }

    return {
      command: env.ComSpec?.toLowerCase().includes('powershell')
        ? env.ComSpec
        : 'powershell.exe',
      args: launch
        ? ['-NoLogo', '-Command', buildPowerShellCommand(launch.program, launch.args)]
        : ['-NoLogo'],
      cwd: windowsCwd,
    };
  }

  const { command, loginArgs } = resolvePosixTerminalShellCommand(env, platform);

  if (launch) {
    return {
      command,
      args: [
        ...loginArgs,
        '-c',
        // CODEX_HOME 재단언은 buildWslTerminalScript의 inner와 같은 이유 —
        // macOS -l 셸도 .zprofile이 CODEX_HOME을 덮으면 오버레이가 무시된다.
        'if [ -n "${TESSERA_CODEX_HOME:-}" ]; then CODEX_HOME="$TESSERA_CODEX_HOME"; export CODEX_HOME; fi; '
        + `exec ${buildPosixCommand(launch.program, launch.args)}`,
      ],
      cwd,
    };
  }

  return { command, args: loginArgs, cwd };
}

export function formatTerminalShellPrefill(options: {
  program: string;
  args: string[];
  platform?: NodeJS.Platform;
  shellKind?: TerminalShellKind;
}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || options.shellKind === 'wsl') {
    return buildPosixCommand(options.program, options.args);
  }
  return options.shellKind === 'cmd'
    ? buildCmdCommand(options.program, options.args)
    : buildPowerShellCommand(options.program, options.args);
}
