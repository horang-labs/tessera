import { spawn } from 'node:child_process';
import logger from '@/lib/logger';
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
 * 프로브 셸은 PTY 실행이 쓰는 셸(resolvePosixTerminalShellCommand)과 동일 —
 * 감지 PATH와 실행 PATH가 항상 일치한다.
 *
 * 미커버: win32에서 shellKind 'wsl'로 뜨는 PTY의 WSL 내부 PATH는 프로브하지
 * 않는다(native `where`만). 필요해지면 wsl.exe 브리지 프로브를 추가할 것.
 */

export interface TerminalProviderDetection {
  providerId: string;
  installed: boolean;
  /** 프로브가 찾은 실행 파일 경로 (installed일 때만). */
  resolvedPath?: string;
}

// 로그인 셸 콜드 부팅(oh-my-zsh/nvm 초기화)까지 감안한 타임아웃.
const DETECT_TIMEOUT_MS = 10_000;
const DETECT_CACHE_TTL_MS = 30_000;

// PTY 실행은 사용자별 override 없이 bare command를 셸에 넘기므로(provider-launch.ts)
// 감지도 서버 프로세스 기준 전역 캐시 하나면 충분하다.
let cachedDetections: { results: TerminalProviderDetection[]; checkedAt: number } | null = null;
let detectionInFlight: Promise<TerminalProviderDetection[]> | null = null;

export async function detectTerminalProviders(
  options: { force?: boolean } = {},
): Promise<TerminalProviderDetection[]> {
  if (
    !options.force
    && cachedDetections
    && Date.now() - cachedDetections.checkedAt < DETECT_CACHE_TTL_MS
  ) {
    return cachedDetections.results;
  }

  if (detectionInFlight) {
    return detectionInFlight;
  }

  detectionInFlight = probeAllProviders()
    .then((results) => {
      cachedDetections = { results, checkedAt: Date.now() };
      return results;
    })
    .finally(() => {
      detectionInFlight = null;
    });
  return detectionInFlight;
}

export function invalidateTerminalProviderDetection(): void {
  cachedDetections = null;
  detectionInFlight = null;
}

async function probeAllProviders(): Promise<TerminalProviderDetection[]> {
  const entries = Object.entries(TERMINAL_PROVIDER_COMMANDS);
  try {
    return process.platform === 'win32'
      ? await probeWithWhere(entries)
      : await probeWithLoginShell(entries);
  } catch (err) {
    // 감지는 어드바이저리 — 프로브 실패가 목록 자체를 막으면 안 된다.
    logger.warn('terminal provider detection failed; reporting all as not installed', {
      error: (err as Error).message,
    });
    return entries.map(([providerId]) => ({ providerId, installed: false }));
  }
}

// 셸 스크립트에 안전하게 인라인할 수 있는 커맨드명만 프로브한다.
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 로그인 셸 1회 부팅으로 전 커맨드를 프로브한다(부팅이 수백 ms~수 초라 커맨드별
 * 셸 spawn은 낭비). 커맨드당 한 줄 `<cmd>\t<path>`(미설치면 path 빈칸)을 출력.
 */
async function probeWithLoginShell(
  entries: Array<[string, string]>,
): Promise<TerminalProviderDetection[]> {
  const safeEntries = entries.filter(([, cmd]) => SAFE_COMMAND_PATTERN.test(cmd));
  const { command: shell, loginArgs } = resolvePosixTerminalShellCommand();
  const script = safeEntries
    .map(
      ([, cmd]) =>
        `p=$(command -v -- ${cmd} 2>/dev/null) && printf '%s\\t%s\\n' ${cmd} "$p" || printf '%s\\t\\n' ${cmd}`,
    )
    .join('; ');

  const { stdout } = await runProbe(shell, [...loginArgs, '-c', script]);

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

async function probeWithWhere(
  entries: Array<[string, string]>,
): Promise<TerminalProviderDetection[]> {
  return Promise.all(
    entries.map(async ([providerId, cmd]) => {
      if (!SAFE_COMMAND_PATTERN.test(cmd)) {
        return { providerId, installed: false };
      }
      const { ok, stdout } = await runProbe('where', [cmd]);
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
    }, DETECT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}
