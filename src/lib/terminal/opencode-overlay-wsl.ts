import { spawn } from 'node:child_process';
import logger from '@/lib/logger';
import { buildOpenCodeHookPluginSource } from './opencode-hook-plugin';

const BASE64_PATTERN = /^[A-Za-z0-9+/=]*$/;
const CREATE_TIMEOUT_MS = 20_000;
const OVERLAY_REPORT_LABEL = 'TESSERA_OPENCODE_OVERLAY';

let sharedOverlayPromise: Promise<string> | undefined;

function assertBase64(value: string): void {
  if (!BASE64_PATTERN.test(value)) {
    throw new Error('OpenCode WSL overlay plugin payload must be base64');
  }
}

/**
 * WSL 안의 공용 OPENCODE_CONFIG_DIR를 준비한다.
 *
 * OpenCode는 설정 폴더마다 플러그인 SDK와 node_modules를 설치한다. 폴더를 지우거나
 * 세션별로 새로 만들면 매 실행마다 설치가 반복되므로, 플러그인 파일만 원자적으로
 * 갱신하고 OpenCode가 만든 package.json/bun.lock/node_modules는 그대로 보존한다.
 */
export function buildWslOpenCodeOverlayCreateScript(pluginSourceB64: string): string {
  assertBase64(pluginSourceB64);
  return [
    'set -eu',
    'umask 077',
    'overlay="$HOME/.tessera/opencode-overlay/shared"',
    'plugins="$overlay/plugins"',
    'mkdir -p "$plugins"',
    'tmp="$plugins/.tessera-lifecycle.js.$$"',
    'trap \'rm -f "$tmp"\' 0 1 2 15',
    `printf '%s' '${pluginSourceB64}' | base64 -d > "$tmp"`,
    'chmod 600 "$tmp"',
    'mv -f "$tmp" "$plugins/tessera-lifecycle.js"',
    `printf '${OVERLAY_REPORT_LABEL}:%s\\n' "$overlay"`,
  ].join('\n');
}

export function readWslOpenCodeOverlayReport(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(`${OVERLAY_REPORT_LABEL}:`)) continue;
    const value = line.slice(OVERLAY_REPORT_LABEL.length + 1).replace(/\r$/, '').trim();
    if (value) return value;
  }
  return undefined;
}

function runWslScript(script: string): Promise<string> {
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
      finish(new Error(`OpenCode WSL overlay script timed out after ${CREATE_TIMEOUT_MS}ms`));
    }, CREATE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      finish(new Error(`Unable to launch wsl.exe for OpenCode overlay: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`OpenCode WSL overlay script exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.on('error', () => { /* EPIPE is reported by close/error. */ });
    child.stdin.end(script);
  });
}

async function materializeSharedOverlay(): Promise<string> {
  const pluginSourceB64 = Buffer.from(buildOpenCodeHookPluginSource(), 'utf8').toString('base64');
  const stdout = await runWslScript(buildWslOpenCodeOverlayCreateScript(pluginSourceB64));
  const overlayDir = readWslOpenCodeOverlayReport(stdout);
  if (!overlayDir?.startsWith('/')) {
    throw new Error('OpenCode WSL overlay script did not report a guest path');
  }
  logger.debug({ overlayDir }, 'OpenCode WSL shared overlay prepared');
  return overlayDir;
}

/**
 * 앱 프로세스마다 한 번만 WSL 공용 오버레이를 준비한다. 실패한 Promise는 캐시하지
 * 않아 다음 터미널 생성에서 재시도할 수 있다. 앱 업데이트/재시작 시 플러그인 파일은
 * 다시 기록되지만 OpenCode가 설치한 의존성 폴더는 유지된다.
 */
export function createOpenCodeOverlayInWsl(): Promise<string> {
  if (sharedOverlayPromise) return sharedOverlayPromise;

  const pending = materializeSharedOverlay().catch((error) => {
    if (sharedOverlayPromise === pending) sharedOverlayPromise = undefined;
    throw error;
  });
  sharedOverlayPromise = pending;
  return pending;
}
