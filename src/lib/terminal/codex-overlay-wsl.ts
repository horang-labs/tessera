import { spawn } from 'node:child_process';
import logger from '@/lib/logger';
import { buildCodexOverlayMarkerJson, CODEX_OVERLAY_MARKER } from '@/lib/codex-home';
import { buildCodexHookSettings } from './codex-hook-settings';
import { appendTrustedHookState, stripHookStateSections } from './codex-overlay';
import type { HookCommandStyle } from './hook-command';

/**
 * WSL 게스트 안에 per-terminal CODEX_HOME 오버레이를 만든다 (win32 호스트 +
 * agentEnvironment 'wsl' 전용).
 *
 * 호스트(codex-overlay.ts)에서 만들면 두 겹으로 깨진다:
 *  1. 소스가 Windows %USERPROFILE%\.codex — 게스트 codex의 계정(~/.codex)이 아니다.
 *  2. Windows 심링크는 개발자 모드 OFF에서 EPERM이고, UNC 너머로 만든 심링크는
 *     게스트에서 풀리지 않는다(orca가 preferCopy를 쓰는 이유).
 * 그래서 게스트 셸이 게스트 파일시스템 안에서 게스트 네이티브 심링크로 만든다 —
 * auth.json 라이브 공유·sessions/ rollout 관통(resume)이라는 오버레이 계약이
 * macOS/Linux와 동일하게 유지된다.
 *
 * 실행은 `wsl.exe --exec sh -s` + stdin 스크립트 스트리밍(orca 릴레이 설치 미러:
 * --exec는 wsl.exe의 `$` 선처리·로그인 셸을 우회하고, stdin은 인용 문제를 원천
 * 차단한다). 데이터(hooks.json/config.toml/마커)는 base64로 건넌다.
 *
 * 두 번 왕복한다: 1차가 오버레이 생성 + hooks.json 기록 + `readlink -f` canonical
 * 경로와 실 config.toml을 보고하고, 호스트가 trust hash를 계산해(경로는 hash 입력이
 * 아니라 [hooks.state] 키에만 들어간다) 2차가 최종 config.toml을 기록한다.
 *
 * 게스트 경로는 기본 ~/.tessera 고정이다 — 호스트의 TESSERA_DATA_DIR은 호스트
 * 파일시스템 설정이라 게스트에 적용하지 않는다.
 */

const SAFE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/=]*$/;

// 1차 호출은 WSL VM 콜드 부팅을 흡수해야 한다(수 초). 2차/정리는 VM이 이미 떠 있다.
const CREATE_TIMEOUT_MS = 20_000;
const FINALIZE_TIMEOUT_MS = 10_000;

/** wsl.exe로 이 세션에서 게스트 오버레이를 만든 터미널 — cleanup 스폰 낭비 방지용. */
const guestOverlayTerminals = new Set<string>();

function assertSafeTerminalId(terminalId: string): void {
  if (!SAFE_TERMINAL_ID.test(terminalId)) {
    throw new Error('Invalid terminal id for Codex overlay');
  }
}

function assertBase64(value: string, label: string): void {
  if (!BASE64_PATTERN.test(value)) {
    throw new Error(`Codex WSL overlay ${label} payload must be base64`);
  }
}

/** 게스트에서 실행할 오버레이 생성 스크립트. 순수 문자열 — 로컬 sh로 테스트 가능. */
export function buildWslCodexOverlayCreateScript(terminalId: string, hooksJsonB64: string): string {
  assertSafeTerminalId(terminalId);
  assertBase64(hooksJsonB64, 'hooks.json');
  return [
    'set -eu',
    `overlay="$HOME/.tessera/codex-overlay/${terminalId}"`,
    'src="${CODEX_HOME:-$HOME/.codex}"',
    // stale 재생성: 이전 런치 잔여 제거(심링크는 unlink만 → 타깃 무손상).
    'rm -rf "$overlay"',
    'mkdir -p "$overlay"',
    'if [ -d "$src" ]; then',
    '  for entry in "$src"/* "$src"/.*; do',
    '    name="${entry##*/}"',
    // hooks.json/config.toml은 우리 파일로 대체. `-e`는 dangling 심링크와
    // 매치 실패로 남은 리터럴 글롭을 함께 거른다(호스트 statSync 스킵과 동일).
    `    case "$name" in .|..|hooks.json|config.toml|${CODEX_OVERLAY_MARKER}) continue ;; esac`,
    '    [ -e "$entry" ] || continue',
    '    ln -s "$src/$name" "$overlay/$name" 2>/dev/null || true',
    '  done',
    'fi',
    `printf '%s' '${hooksJsonB64}' | base64 -d > "$overlay/hooks.json"`,
    'chmod 600 "$overlay/hooks.json"',
    // 호스트가 파싱하는 보고 라인들. --exec sh는 non-login이라 rc 노이즈가 없다.
    'printf \'TESSERA_OVERLAY:%s\\n\' "$overlay"',
    'printf \'TESSERA_SRC:%s\\n\' "$src"',
    'printf \'TESSERA_HOOKS_REAL:%s\\n\' "$(readlink -f "$overlay/hooks.json")"',
    'if [ -f "$src/config.toml" ]; then',
    // GNU 기본 76자 래핑을 tr로 푼다(busybox 호환: -w0 미사용).
    '  printf \'TESSERA_CONFIG_B64:%s\\n\' "$(base64 < "$src/config.toml" | tr -d \'\\n\')"',
    'fi',
  ].join('\n');
}

/** 2차: trust state가 합쳐진 config.toml과 오버레이 마커를 기록한다. */
export function buildWslCodexOverlayFinalizeScript(
  terminalId: string,
  configTomlB64: string,
  markerJsonB64: string,
): string {
  assertSafeTerminalId(terminalId);
  assertBase64(configTomlB64, 'config.toml');
  assertBase64(markerJsonB64, 'marker');
  return [
    'set -eu',
    `overlay="$HOME/.tessera/codex-overlay/${terminalId}"`,
    `printf '%s' '${configTomlB64}' | base64 -d > "$overlay/config.toml"`,
    'chmod 600 "$overlay/config.toml"',
    `printf '%s' '${markerJsonB64}' | base64 -d > "$overlay/${CODEX_OVERLAY_MARKER}"`,
    `chmod 600 "$overlay/${CODEX_OVERLAY_MARKER}"`,
  ].join('\n');
}

export function buildWslCodexOverlayCleanupScript(terminalId: string): string {
  assertSafeTerminalId(terminalId);
  return `rm -rf "$HOME/.tessera/codex-overlay/${terminalId}"`;
}

/** 스크립트 stdout에서 `LABEL:value` 보고 라인을 찾는다. */
export function readWslOverlayReport(stdout: string, label: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (line.startsWith(`${label}:`)) {
      const value = line.slice(label.length + 1).replace(/\r$/, '').trim();
      if (value) return value;
    }
  }
  return undefined;
}

function runWslScript(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['--exec', 'sh', '-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Codex WSL overlay script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish(new Error(`Unable to launch wsl.exe: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Codex WSL overlay script exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.on('error', () => { /* EPIPE — close 핸들러가 실패를 보고한다 */ });
    child.stdin.end(script);
  });
}

function toBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * 게스트 오버레이를 생성하고 게스트 POSIX 경로를 반환한다.
 * 반환 경로를 CODEX_HOME으로 자식에 넘길 때 WSLENV 경로 변환(/p)을 붙이면 안 된다 —
 * 이미 게스트 경로다(terminal-manager가 값의 '/' 접두로 판별한다).
 */
export async function createCodexOverlayInWsl(
  terminalId: string,
  hookStyle: HookCommandStyle = 'posix',
): Promise<string> {
  assertSafeTerminalId(terminalId);
  const hookSettings = buildCodexHookSettings(hookStyle);
  const hooksJson = JSON.stringify(hookSettings, null, 2) + '\n';

  const createdStdout = await runWslScript(
    buildWslCodexOverlayCreateScript(terminalId, toBase64(hooksJson)),
    CREATE_TIMEOUT_MS,
  );
  const overlayPath = readWslOverlayReport(createdStdout, 'TESSERA_OVERLAY');
  const accountHome = readWslOverlayReport(createdStdout, 'TESSERA_SRC');
  const canonicalHooksPath = readWslOverlayReport(createdStdout, 'TESSERA_HOOKS_REAL');
  if (!overlayPath || !accountHome || !canonicalHooksPath) {
    throw new Error('Codex WSL overlay script did not report the overlay paths');
  }

  const configB64 = readWslOverlayReport(createdStdout, 'TESSERA_CONFIG_B64');
  const rawConfigToml = configB64 ? Buffer.from(configB64, 'base64').toString('utf8') : '';
  const configToml = appendTrustedHookState(
    stripHookStateSections(rawConfigToml),
    canonicalHooksPath,
    hookSettings,
  );

  await runWslScript(
    buildWslCodexOverlayFinalizeScript(
      terminalId,
      toBase64(configToml),
      toBase64(buildCodexOverlayMarkerJson(accountHome)),
    ),
    FINALIZE_TIMEOUT_MS,
  );

  guestOverlayTerminals.add(terminalId);
  logger.debug({ terminalId, overlayPath, accountHome }, 'codex WSL overlay created');
  return overlayPath;
}

/**
 * 게스트 오버레이 제거(fire-and-forget). 이 서버 프로세스가 만든 터미널만 스폰한다 —
 * 재시작으로 추적을 잃은 잔여물은 다음 동일 terminalId 생성의 rm -rf가 치운다.
 */
export function cleanupCodexOverlayInWsl(terminalId: string): void {
  if (!guestOverlayTerminals.delete(terminalId)) return;
  try {
    runWslScript(buildWslCodexOverlayCleanupScript(terminalId), FINALIZE_TIMEOUT_MS)
      .catch((err) => {
        logger.debug({ err, terminalId }, 'codex WSL overlay cleanup skipped');
      });
  } catch (err) {
    logger.debug({ err, terminalId }, 'codex WSL overlay cleanup skipped');
  }
}
