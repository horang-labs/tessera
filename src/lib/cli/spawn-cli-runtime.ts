import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { delimiter } from 'path';
import { getRuntimePlatform } from '../system/runtime-platform';
import type { AgentEnvironment } from '../settings/types';
import type { SpawnCliCache } from './spawn-cli-cache';

type LoginShellEnvironment = Record<string, string>;

const PATH_MARKER_START = '__TESSERA_PATH_START__';
const PATH_MARKER_END = '__TESSERA_PATH_END__';
const WSL_FALLBACK_LOGIN_SHELL = 'bash';
const WSL_LOGIN_SHELL_PROBE_SCRIPT = [
  'user="$(id -un 2>/dev/null || printf %s "${USER:-}")"',
  'shell=""',
  'if command -v getent >/dev/null 2>&1 && [ -n "$user" ]; then shell="$(getent passwd "$user" 2>/dev/null | cut -d: -f7)"; fi',
  'if [ -z "$shell" ] && [ -n "$user" ] && [ -r /etc/passwd ]; then shell="$(awk -F: -v user="$user" \'$1 == user { print $7; exit }\' /etc/passwd)"; fi',
  `case "$shell" in /*) printf "%s" "$shell" ;; *) printf "${WSL_FALLBACK_LOGIN_SHELL}" ;; esac`,
].join('; ');
// Heavy zsh setups (oh-my-zsh + powerlevel10k + nvm + pyenv + corporate AV
// scanning the binary on first launch) routinely take 5–8s for a cold
// `-l -c` invocation. 5s was the previous value and produced empty PATH
// captures for a non-trivial fraction of macOS users on cold boot.
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 10_000;

// Login-shell env keys we trust enough to inherit verbatim into spawned CLIs.
// Captured from `$SHELL -l -c env` on macOS/Linux when the parent process
// (typically the Electron main process on a GUI launch) doesn't have them.
const LOGIN_ENV_EXACT_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);
const LOGIN_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'CODEX_',
  'OPENAI_',
  'OPENCODE_',
];
const MAC_SUPPLEMENTAL_CLI_PATHS = [
  '.bun/bin',
  '.cargo/bin',
  'go/bin',
  '.deno/bin',
  '.local/bin',
];

// Absolute supplemental paths on macOS/Linux that aren't tied to $HOME and are
// commonly missing from a tessera parent process's PATH when launched from
// Finder/GUI on macOS or systemd on Linux. Apple Silicon Homebrew lives at
// /opt/homebrew/bin; Intel Homebrew at /usr/local/bin.
//
// The login-shell PATH probe usually surfaces these already when the user has a
// normal .zshrc; this list is a fallback for the cases the probe can't help —
// fish/nushell users (POSIX probe fails to parse), `brew shellenv` only in
// .zshrc (login shell misses it), slow dotfiles that hit the probe timeout.
const UNIX_ABSOLUTE_SUPPLEMENTAL_CLI_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
];

export function resolveDefaultAgentEnvironment(): AgentEnvironment {
  return 'native';
}

export function invalidateSpawnCliRuntimeCache(cache: SpawnCliCache): void {
  cache.loginShell = null;
  cache.didResolveLoginShell = false;
  cache.loginShellEnvironment = null;
  cache.didResolveLoginShellEnvironment = false;
  cache.loginShellPath = null;
  cache.didResolveLoginShellPath = false;
  cache.wslLoginShell = null;
  cache.didResolveWslLoginShell = false;
}

export function buildSpawnEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  cache: SpawnCliCache,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };

  if (getRuntimePlatform() === 'win32') {
    const windowsPath = resolveWindowsCliPath(env);
    if (windowsPath) {
      mergeIntoEnvironmentPath(env, windowsPath);
    }
    return env;
  }

  const shell = resolveLoginShell(cache, env);

  // Capture login-shell env vars (proxy, CA certs, ANTHROPIC_*, etc.) on both
  // macOS and Linux. GUI launchers (Finder, Dock, freedesktop .desktop entries)
  // start the app with a minimal env that does NOT execute the user's
  // .zshrc/.bashrc, so users whose dotfiles set HTTPS_PROXY or
  // NODE_EXTRA_CA_CERTS for corporate CAs would otherwise lose them.
  const loginShellEnv = resolveLoginShellEnvironment(cache, shell, env);
  if (loginShellEnv) {
    mergeWhitelistedLoginEnvironment(env, loginShellEnv);
  }

  const loginShellPath = resolveLoginShellPath(cache, shell, env);
  if (loginShellPath) {
    mergeIntoEnvironmentPath(env, loginShellPath);
  }

  if (getRuntimePlatform() === 'darwin') {
    const supplementalPath = resolveMacSupplementalCliPath(env);
    if (supplementalPath) {
      appendIntoEnvironmentPath(env, supplementalPath);
    }
    return env;
  }

  const linuxSupplementalPath = resolveLinuxSupplementalCliPath();
  if (linuxSupplementalPath) {
    appendIntoEnvironmentPath(env, linuxSupplementalPath);
  }

  return env;
}

function resolveLinuxSupplementalCliPath(): string | null {
  const candidates = UNIX_ABSOLUTE_SUPPLEMENTAL_CLI_PATHS.filter((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  return candidates.length > 0
    ? [...new Set(candidates)].join(getEnvironmentPathDelimiter())
    : null;
}

export function spawnCliProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  agentEnv: AgentEnvironment,
  cache: SpawnCliCache,
): ChildProcess {
  const env = buildSpawnEnvironment((options.env as NodeJS.ProcessEnv) ?? process.env, cache);
  const spawnOptions = buildPlatformSpawnOptions(options, env);

  if (agentEnv === 'wsl' && getRuntimePlatform() === 'win32') {
    return spawnWslCli(command, args, spawnOptions, cache, env);
  }

  if (agentEnv === 'native' && getRuntimePlatform() === 'win32') {
    return spawnWindowsNativeCli(command, args, spawnOptions);
  }

  if (agentEnv === 'native' && isRunningInWsl()) {
    return spawnWindowsNativeCli(command, args, spawnOptions);
  }

  return spawn(command, args, spawnOptions);
}

export function normalizeCwdForCliEnvironment(
  cwd: string,
  agentEnv: AgentEnvironment,
): string {
  if (agentEnv === 'wsl' && getRuntimePlatform() === 'win32') {
    return toWslPath(cwd) ?? cwd;
  }

  if (agentEnv === 'native' && isRunningInWsl()) {
    return toWindowsPath(cwd) ?? cwd;
  }

  return cwd;
}

function isRunningInWsl(): boolean {
  if (getRuntimePlatform() !== 'linux') {
    return false;
  }

  try {
    if (!existsSync('/proc/version')) {
      return false;
    }

    const content = readFileSync('/proc/version', 'utf8').toLowerCase();
    return content.includes('microsoft') || content.includes('wsl');
  } catch {
    return false;
  }
}

function resolveLoginShell(cache: SpawnCliCache, env: NodeJS.ProcessEnv): string | null {
  if (cache.didResolveLoginShell) {
    return cache.loginShell;
  }

  cache.didResolveLoginShell = true;

  const platform = getRuntimePlatform();

  if (platform === 'darwin') {
    const macUserShell = resolveMacUserShell(env);
    if (macUserShell) {
      cache.loginShell = macUserShell;
      return cache.loginShell;
    }
  }

  const configuredShell = env.SHELL || process.env.SHELL;
  if (configuredShell) {
    cache.loginShell = configuredShell;
    return cache.loginShell;
  }

  if (platform === 'darwin') {
    cache.loginShell = '/bin/zsh';
    return cache.loginShell;
  }

  if (platform === 'linux') {
    cache.loginShell = '/bin/bash';
    return cache.loginShell;
  }

  return null;
}

function mergePathValues(primaryPath: string, secondaryPath?: string): string {
  const merged = [primaryPath, secondaryPath]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .flatMap((value) => value.split(getEnvironmentPathDelimiter()))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return [...new Set(merged)].join(getEnvironmentPathDelimiter());
}

function getEnvironmentPathDelimiter(): string {
  return getRuntimePlatform() === 'win32' ? ';' : delimiter;
}

function getPathEnvironmentKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function mergeIntoEnvironmentPath(env: NodeJS.ProcessEnv, primaryPath: string): void {
  const pathKey = getPathEnvironmentKey(env);
  env[pathKey] = mergePathValues(primaryPath, env[pathKey]);
}

function appendIntoEnvironmentPath(env: NodeJS.ProcessEnv, secondaryPath: string): void {
  const pathKey = getPathEnvironmentKey(env);
  env[pathKey] = mergePathValues(env[pathKey] ?? '', secondaryPath);
}

function resolveWindowsCliPath(env: NodeJS.ProcessEnv): string | null {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();
  const programFiles = env.ProgramFiles?.trim();
  const programFilesX86 = env['ProgramFiles(x86)']?.trim();
  const chocolateyInstall = env.ChocolateyInstall?.trim();
  const scoop = env.SCOOP?.trim();
  const candidates = [
    appData ? `${appData}\\npm` : null,
    userProfile ? `${userProfile}\\AppData\\Roaming\\npm` : null,
    programFiles ? `${programFiles}\\nodejs` : null,
    programFilesX86 ? `${programFilesX86}\\nodejs` : null,
    env.NVM_HOME?.trim() || (appData ? `${appData}\\nvm` : null),
    env.NVM_SYMLINK?.trim() || (programFiles ? `${programFiles}\\nodejs` : null),
    env.FNM_MULTISHELL_PATH?.trim() || null,
    localAppData ? `${localAppData}\\fnm_multishells` : null,
    userProfile ? `${userProfile}\\.volta\\bin` : null,
    scoop ? `${scoop}\\shims` : userProfile ? `${userProfile}\\scoop\\shims` : null,
    localAppData ? `${localAppData}\\pnpm` : null,
    localAppData ? `${localAppData}\\OfficeCli` : null,
    chocolateyInstall ? `${chocolateyInstall}\\bin` : 'C:\\ProgramData\\chocolatey\\bin',
    programFiles ? `${programFiles}\\Git\\cmd` : null,
    programFiles ? `${programFiles}\\Git\\bin` : null,
    programFiles ? `${programFiles}\\Git\\usr\\bin` : null,
    programFilesX86 ? `${programFilesX86}\\Git\\cmd` : null,
    programFilesX86 ? `${programFilesX86}\\Git\\bin` : null,
    programFilesX86 ? `${programFilesX86}\\Git\\usr\\bin` : null,
    'C:\\cygwin64\\bin',
    'C:\\cygwin\\bin',
    userProfile ? `${userProfile}\\.bun\\bin` : null,
    userProfile ? `${userProfile}\\.cargo\\bin` : null,
    userProfile ? `${userProfile}\\go\\bin` : null,
    userProfile ? `${userProfile}\\.deno\\bin` : null,
    userProfile ? `${userProfile}\\.local\\bin` : null,
  ].filter((value): value is string => Boolean(value));

  const existingCandidates = candidates.filter((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });

  return existingCandidates.length > 0
    ? [...new Set(existingCandidates)].join(getEnvironmentPathDelimiter())
    : null;
}

function parseMarkedPath(stdout: string): string | null {
  const startIndex = stdout.indexOf(PATH_MARKER_START);
  const endIndex = stdout.indexOf(PATH_MARKER_END, startIndex + PATH_MARKER_START.length);

  if (startIndex === -1 || endIndex === -1) {
    return null;
  }

  const resolvedPath = stdout
    .slice(startIndex + PATH_MARKER_START.length, endIndex)
    .trim();

  return resolvedPath || null;
}

function resolveLoginShellPath(
  cache: SpawnCliCache,
  shell: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (cache.didResolveLoginShellPath) {
    return cache.loginShellPath;
  }

  cache.didResolveLoginShellPath = true;

  if (getRuntimePlatform() === 'win32') {
    return null;
  }

  if (!shell) {
    return null;
  }

  try {
    const probe = spawnSync(
      shell,
      ['-ilc', `printf '${PATH_MARKER_START}%s${PATH_MARKER_END}' "$PATH"`],
      {
        encoding: 'utf8',
        env,
        timeout: LOGIN_SHELL_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    if (probe.status !== 0 || typeof probe.stdout !== 'string') {
      return null;
    }

    cache.loginShellPath = parseMarkedPath(probe.stdout);
    return cache.loginShellPath;
  } catch {
    return null;
  }
}

function resolveLoginShellEnvironment(
  cache: SpawnCliCache,
  shell: string | null,
  env: NodeJS.ProcessEnv,
): LoginShellEnvironment | null {
  if (cache.didResolveLoginShellEnvironment) {
    return cache.loginShellEnvironment;
  }

  cache.didResolveLoginShellEnvironment = true;

  if (getRuntimePlatform() === 'win32' || !shell) {
    return null;
  }

  try {
    const probe = spawnSync(shell, ['-l', '-c', 'env'], {
      encoding: 'utf8',
      env,
      timeout: LOGIN_SHELL_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });

    if (probe.status !== 0 || typeof probe.stdout !== 'string') {
      return null;
    }

    cache.loginShellEnvironment = parseEnvOutput(probe.stdout);
    return cache.loginShellEnvironment;
  } catch {
    return null;
  }
}

function resolveMacUserShell(env: NodeJS.ProcessEnv): string | null {
  const username = (env.USER || env.LOGNAME || process.env.USER || process.env.LOGNAME)?.trim();
  if (!username) {
    return null;
  }

  try {
    const probe = spawnSync('dscl', ['.', '-read', `/Users/${username}`, 'UserShell'], {
      encoding: 'utf8',
      env,
      timeout: 2000,
      windowsHide: true,
    });

    if (probe.status !== 0 || typeof probe.stdout !== 'string') {
      return null;
    }

    const match = probe.stdout.match(/(?:^|\n)UserShell:\s*(\S+)/);
    const shell = match?.[1]?.trim();
    return shell && shell.startsWith('/') ? shell : null;
  } catch {
    return null;
  }
}

function parseEnvOutput(stdout: string): LoginShellEnvironment | null {
  const parsed: LoginShellEnvironment = {};

  for (const line of stdout.split(/\r?\n/)) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    parsed[key] = line.slice(separatorIndex + 1);
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function mergeWhitelistedLoginEnvironment(
  target: NodeJS.ProcessEnv,
  source: LoginShellEnvironment,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    if (key === 'PATH') {
      mergeIntoEnvironmentPath(target, value);
      continue;
    }

    // Account-wide Codex work may intentionally replace a PTY session overlay.
    // Keep the existing login-shell precedence for every other supplemental key.
    if (isAllowedLoginEnvironmentKey(key)
      && (key !== 'CODEX_HOME' || !Object.hasOwn(target, key))) {
      target[key] = value;
    }
  }
}

function isAllowedLoginEnvironmentKey(key: string): boolean {
  if (LOGIN_ENV_EXACT_KEYS.has(key)) {
    return true;
  }

  const upperKey = key.toUpperCase();
  return LOGIN_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
}

function resolveMacSupplementalCliPath(env: NodeJS.ProcessEnv): string | null {
  const home = (env.HOME || process.env.HOME)?.trim();
  const homeRelative = home
    ? MAC_SUPPLEMENTAL_CLI_PATHS.map((relativePath) => `${home}/${relativePath}`)
    : [];

  const candidates = [...homeRelative, ...UNIX_ABSOLUTE_SUPPLEMENTAL_CLI_PATHS]
    .filter((candidate) => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    });

  return candidates.length > 0 ? [...new Set(candidates)].join(getEnvironmentPathDelimiter()) : null;
}

function buildPlatformSpawnOptions(
  options: SpawnOptions,
  env: NodeJS.ProcessEnv,
): SpawnOptions {
  if (getRuntimePlatform() === 'win32') {
    return { ...options, env, windowsHide: true };
  }

  // Spawn each CLI as a new session/process-group leader so we can later
  // target the whole subtree via `process.kill(-pid, signal)`. Without this,
  // CLI-spawned grandchildren (dev servers, test runners, etc.) get
  // re-parented to init when the CLI exits and linger as orphans.
  return { ...options, env, detached: true };
}

function spawnWslCli(
  command: string,
  args: string[],
  options: SpawnOptions,
  cache: SpawnCliCache,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const { cwd, ...spawnOptions } = options;
  const shell = resolveWslLoginShell(cache, env);
  const wslCwd = typeof cwd === 'string' && cwd.length > 0
    ? normalizeCwdForCliEnvironment(cwd, 'wsl')
    : null;
  const script = buildLoginShellExecScript(command, args, wslCwd);

  return spawn('wsl', [shell, '-i', '-l', '-c', script], spawnOptions);
}

function spawnWindowsNativeCli(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  if (isExplicitExecutablePath(command)) {
    return spawnResolvedWindowsNativeCli(command, args, options);
  }

  if (getRuntimePlatform() === 'win32') {
    return spawnWindowsNativeCliViaCmd(command, args, options);
  }

  return spawnWindowsNativeCliViaPowerShell(command, args, options);
}

function spawnWindowsNativeCliViaCmd(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn('cmd.exe', ['/d', '/c', command, ...args], options);
}

function spawnResolvedWindowsNativeCli(
  windowsPath: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  const extension = getWindowsPathExtension(windowsPath);
  const platform = getRuntimePlatform();

  if (platform === 'win32') {
    if (extension === '.cmd' || extension === '.bat') {
      return spawn('cmd.exe', ['/d', '/c', windowsPath, ...args], options);
    }

    if (extension === '.ps1') {
      return spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsPath, ...args],
        options,
      );
    }

    return spawn(windowsPath, args, options);
  }

  if (extension === '.cmd' || extension === '.bat' || extension === '.ps1') {
    return spawnWindowsNativeCliViaPowerShell(windowsPath, args, options);
  }

  const wslPath = windowsExecutablePathToWslPath(windowsPath);
  if (wslPath) {
    return spawn(wslPath, args, options);
  }

  return spawnWindowsNativeCliViaPowerShell(windowsPath, args, options);
}

function spawnWindowsNativeCliViaPowerShell(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  const { cwd, ...spawnOptions } = options;
  const scriptParts = ['$ErrorActionPreference = "Stop"'];

  if (typeof cwd === 'string' && cwd.length > 0) {
    const windowsCwd = toWindowsPath(cwd);
    if (windowsCwd) {
      scriptParts.push(`Set-Location -LiteralPath ${quotePowerShellString(windowsCwd)}`);
    }
  }

  const commandExpression = [
    '&',
    quotePowerShellString(command),
    ...args.map(quotePowerShellString),
  ].join(' ');
  scriptParts.push(commandExpression);
  scriptParts.push('exit $LASTEXITCODE');

  return spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scriptParts.join('; ')],
    spawnOptions,
  );
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toWindowsPath(cwd: string): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(cwd)) {
    return cwd.replace(/\//g, '\\');
  }

  const mountedDriveMatch = cwd.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (mountedDriveMatch) {
    const drive = mountedDriveMatch[1].toUpperCase();
    const rest = mountedDriveMatch[2]?.replace(/\//g, '\\') ?? '';
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  if (cwd.startsWith('\\\\')) {
    return cwd;
  }

  if (cwd.startsWith('//')) {
    return cwd.replace(/\//g, '\\');
  }

  const distro = process.env.WSL_DISTRO_NAME;
  if (!distro || !cwd.startsWith('/')) {
    return null;
  }

  return `\\\\wsl.localhost\\${distro}${cwd.replace(/\//g, '\\')}`;
}

function toWslPath(cwd: string): string | null {
  const driveMatch = cwd.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/[\\/]+/g, '/');
    return `/mnt/${drive}/${rest}`;
  }

  const uncMatch = cwd.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\?(.*)$/i);
  if (uncMatch) {
    const rest = uncMatch[2].replace(/\\/g, '/').replace(/^\/+/, '');
    return rest ? `/${rest}` : '/';
  }

  const slashUncMatch = cwd.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)\/?(.*)$/i);
  if (slashUncMatch) {
    const rest = slashUncMatch[2].replace(/^\/+/, '');
    return rest ? `/${rest}` : '/';
  }

  return null;
}

function getWindowsPathExtension(value: string): string {
  const match = value.match(/\.([^.\\/]+)$/);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function quoteBashArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildLoginShellExecScript(
  command: string,
  args: string[],
  cwd: string | null,
): string {
  const commandExpression = [
    'exec',
    quoteBashArg(command),
    ...args.map(quoteBashArg),
  ].join(' ');

  if (!cwd) {
    return commandExpression;
  }

  return `cd -- ${quoteBashArg(cwd)} && ${commandExpression}`;
}

function windowsExecutablePathToWslPath(windowsPath: string): string | null {
  const driveMatch = windowsPath.match(/^([a-zA-Z]):\\(.*)$/);
  if (!driveMatch) {
    return null;
  }

  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function resolveWslLoginShell(cache: SpawnCliCache, env: NodeJS.ProcessEnv): string {
  if (cache.didResolveWslLoginShell) {
    return cache.wslLoginShell ?? WSL_FALLBACK_LOGIN_SHELL;
  }

  cache.didResolveWslLoginShell = true;

  try {
    const probe = spawnSync(
      'wsl',
      ['sh', '-lc', WSL_LOGIN_SHELL_PROBE_SCRIPT],
      {
        encoding: 'utf8',
        env,
        timeout: LOGIN_SHELL_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    if (probe.status !== 0 || typeof probe.stdout !== 'string') {
      cache.wslLoginShell = WSL_FALLBACK_LOGIN_SHELL;
      return cache.wslLoginShell;
    }

    const shell = probe.stdout.trim();
    cache.wslLoginShell = shell.startsWith('/') ? shell : WSL_FALLBACK_LOGIN_SHELL;
    return cache.wslLoginShell;
  } catch {
    cache.wslLoginShell = WSL_FALLBACK_LOGIN_SHELL;
    return cache.wslLoginShell;
  }
}

function isExplicitExecutablePath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value);
}
