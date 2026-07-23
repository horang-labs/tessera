import { spawn } from 'node:child_process';
import logger from '@/lib/logger';
import type { AgentEnvironment } from '@/lib/settings/types';
import { TERMINAL_PROVIDER_COMMANDS } from './provider-launch';
import { resolvePosixTerminalShellCommand } from './terminal-resolver';

/**
 * PTY 모드 프로바이더 감지 (orca식 어드바이저리).
 *
 * GUI 모드 감지(connection-checker: `--version` + `auth status`, 실행의 전제조건)와
 * 완전히 분리된 경로다. PTY는 실행을 로그인 셸에 위임하므로 감지가 실행을
 * 게이팅하지 않는다 — 여기서는 "설치 여부"만 로그인 셸 `command -v`로 확인해
 * UI의 정렬/기본값/회색 표시에 쓴다. auth/로그인 상태는 보지 않는다(로그인
 * 안 된 CLI는 PTY에서 TUI가 직접 로그인 화면을 띄워 준다).
 *
 * 프로브 셸은 PTY 실행이 쓰는 셸과 동일 — 감지 PATH와 실행 PATH가 항상 일치한다:
 *  - posix: resolvePosixTerminalShellCommand (macOS/Linux 서버)
 *  - win32 native: `where` (Windows PATH)
 *  - win32 + agentEnvironment 'wsl': wsl.exe 게스트 로그인 셸 `command -v`
 *    (buildWslTerminalScript의 셸 해석 체인과 동일한 3단계 + `-l -i -c`)
 */

export interface TerminalProviderDetection {
  providerId: string;
  installed: boolean;
  /** 프로브가 찾은 실행 파일 경로 (installed일 때만). */
  resolvedPath?: string;
}

// 로그인 셸 콜드 부팅(oh-my-zsh/nvm 초기화)까지 감안한 타임아웃.
const DETECT_TIMEOUT_MS = 10_000;
// WSL 프로브는 VM 콜드 부팅까지 흡수해야 한다.
const WSL_DETECT_TIMEOUT_MS = 20_000;
const DETECT_CACHE_TTL_MS = 30_000;

// PTY 실행은 사용자별 override 없이 bare command를 셸에 넘기므로(provider-launch.ts)
// 감지도 서버 프로세스 기준 환경별 캐시면 충분하다. win32에서 native/wsl은 서로 다른
// PATH 세계라 캐시를 분리한다(설정 전환 시 invalidate는 settings PUT이 호출).
interface DetectionCacheEntry {
  results: TerminalProviderDetection[];
  checkedAt: number;
}
const cachedDetections = new Map<AgentEnvironment, DetectionCacheEntry>();
const detectionInFlight = new Map<AgentEnvironment, Promise<TerminalProviderDetection[]>>();

function normalizeDetectionEnvironment(environment?: AgentEnvironment): AgentEnvironment {
  // 비-win32에서 wsl 환경은 존재하지 않는다 — posix 프로브 하나로 수렴.
  if (process.platform !== 'win32') return 'native';
  return environment === 'wsl' ? 'wsl' : 'native';
}

export async function detectTerminalProviders(
  options: { force?: boolean; environment?: AgentEnvironment } = {},
): Promise<TerminalProviderDetection[]> {
  const environment = normalizeDetectionEnvironment(options.environment);
  const cached = cachedDetections.get(environment);
  if (!options.force && cached && Date.now() - cached.checkedAt < DETECT_CACHE_TTL_MS) {
    return cached.results;
  }

  const inFlight = detectionInFlight.get(environment);
  if (inFlight) {
    return inFlight;
  }

  const probe = probeAllProviders(environment)
    .then((results) => {
      cachedDetections.set(environment, { results, checkedAt: Date.now() });
      return results;
    })
    .finally(() => {
      detectionInFlight.delete(environment);
    });
  detectionInFlight.set(environment, probe);
  return probe;
}

export function invalidateTerminalProviderDetection(): void {
  cachedDetections.clear();
  detectionInFlight.clear();
}

async function probeAllProviders(
  environment: AgentEnvironment,
): Promise<TerminalProviderDetection[]> {
  const entries = Object.entries(TERMINAL_PROVIDER_COMMANDS);
  try {
    if (process.platform !== 'win32') return await probeWithLoginShell(entries);
    return environment === 'wsl'
      ? await probeWithWslLoginShell(entries)
      : await probeWithWhere(entries);
  } catch (err) {
    // 감지는 어드바이저리 — 프로브 실패가 목록 자체를 막으면 안 된다.
    logger.warn('terminal provider detection failed; reporting all as not installed', {
      environment,
      error: (err as Error).message,
    });
    return entries.map(([providerId]) => ({ providerId, installed: false }));
  }
}

// 셸 스크립트에 안전하게 인라인할 수 있는 커맨드명만 프로브한다.
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 커맨드당 한 줄 `<cmd>\t<path>`(미설치면 path 빈칸)을 출력하는 프로브 본문. */
function buildCommandProbeScript(entries: Array<[string, string]>): string {
  return entries
    .filter(([, cmd]) => SAFE_COMMAND_PATTERN.test(cmd))
    .map(
      ([, cmd]) =>
        `p=$(command -v -- ${cmd} 2>/dev/null) && printf '%s\\t%s\\n' ${cmd} "$p" || printf '%s\\t\\n' ${cmd}`,
    )
    .join('; ');
}

/** 프로브 stdout을 파싱한다. 탭 없는 라인(셸 rc 노이즈)은 무시된다. */
function parseCommandProbeOutput(
  entries: Array<[string, string]>,
  stdout: string,
): TerminalProviderDetection[] {
  const pathByCommand = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    pathByCommand.set(line.slice(0, tab), line.slice(tab + 1).trim());
  }

  return entries.map(([providerId, cmd]) => {
    const resolvedPath = pathByCommand.get(cmd);
    return {
      providerId,
      installed: Boolean(resolvedPath),
      ...(resolvedPath ? { resolvedPath } : {}),
    };
  });
}

/**
 * 로그인 셸 1회 부팅으로 전 커맨드를 프로브한다(부팅이 수백 ms~수 초라 커맨드별
 * 셸 spawn은 낭비).
 */
async function probeWithLoginShell(
  entries: Array<[string, string]>,
): Promise<TerminalProviderDetection[]> {
  const { command: shell, loginArgs } = resolvePosixTerminalShellCommand();
  const { stdout } = await runProbe(
    shell,
    [...loginArgs, '-c', buildCommandProbeScript(entries)],
    DETECT_TIMEOUT_MS,
  );
  return parseCommandProbeOutput(entries, stdout);
}

function quotePosixArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * win32 + agentEnvironment 'wsl': 게스트 로그인 셸로 프로브한다.
 * 셸 해석 3단계와 `-l -i -c` 래핑은 실행 경로(buildWslTerminalScript)와 동일 —
 * 감지=실행 일치. 인터랙티브 셸의 rc 노이즈는 탭 파서가 걸러낸다.
 */
async function probeWithWslLoginShell(
  entries: Array<[string, string]>,
): Promise<TerminalProviderDetection[]> {
  const script = [
    'shell="${SHELL:-}"',
    'if [ -z "$shell" ] || [ ! -x "$shell" ]; then shell="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; fi',
    'if [ -z "$shell" ] || [ ! -x "$shell" ]; then shell="$(command -v bash 2>/dev/null || command -v sh)"; fi',
    `exec "$shell" -l -i -c ${quotePosixArg(buildCommandProbeScript(entries))}`,
  ].join('; ');
  const { stdout } = await runProbe(
    'wsl.exe',
    ['-e', 'sh', '-c', script],
    WSL_DETECT_TIMEOUT_MS,
  );
  return parseCommandProbeOutput(entries, stdout);
}

async function probeWithWhere(
  entries: Array<[string, string]>,
): Promise<TerminalProviderDetection[]> {
  return Promise.all(
    entries.map(async ([providerId, cmd]) => {
      if (!SAFE_COMMAND_PATTERN.test(cmd)) {
        return { providerId, installed: false };
      }
      const { ok, stdout } = await runProbe('where', [cmd], DETECT_TIMEOUT_MS);
      const resolvedPath = ok ? stdout.split(/\r?\n/)[0]?.trim() : undefined;
      return {
        providerId,
        installed: ok,
        ...(resolvedPath ? { resolvedPath } : {}),
      };
    }),
  );
}

function runProbe(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}
