import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import logger from '@/lib/logger';
import { resolveCodexAccountHome } from '@/lib/codex-home';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import {
  buildCodexHookSettings,
  CODEX_HOOK_EVENT_LABEL,
  type CodexHookCommand,
  type CodexHookEventName,
  type CodexHookSettings,
} from './codex-hook-settings';

/**
 * 실 CODEX_HOME. process.env.CODEX_HOME은 절대 오버레이로 덮어쓰지 않는다
 * (오버레이 경로는 launchEnv로만 자식에 전달) → 항상 사용자 실제 홈을 가리킨다.
 * 미설정이면 ~/.codex.
 */
function overlayDirFor(terminalId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(terminalId)) {
    throw new Error('Invalid terminal id for Codex overlay');
  }
  return getTesseraDataPath('codex-overlay', terminalId);
}

/** 방어적: 과거 실험이 남긴 [hooks.state.*] TOML 테이블 제거(사용자 실 config엔 없음). */
function stripHookStateSections(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) skipping = /^hooks\.state\b/.test(header[1].trim());
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Codex command_hook_hash와 동일한 정규화·직렬화 계약. */
function computeTrustedHash(
  eventName: CodexHookEventName,
  hook: CodexHookCommand,
  matcher?: string,
): string {
  const normalizedHook: Record<string, unknown> = {
    type: 'command',
    command: hook.command,
    timeout: Math.max(1, hook.timeout ?? 600),
    async: hook.async ?? false,
  };
  if (hook.statusMessage !== undefined) normalizedHook.statusMessage = hook.statusMessage;

  const identity: Record<string, unknown> = {
    event_name: CODEX_HOOK_EVENT_LABEL[eventName],
    hooks: [normalizedHook],
  };
  // Codex는 UserPromptSubmit/Stop의 matcher를 훅 identity에서 제외한다.
  if (eventName === 'SessionStart' && matcher !== undefined) identity.matcher = matcher;
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(identity)))
    .digest('hex');
  return `sha256:${digest}`;
}

function usesWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\');
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
}

function formatHookStateKey(key: string): string {
  if (usesWindowsPath(key) && !key.includes("'")) return `'${key}'`;
  return `"${escapeTomlBasicString(key)}"`;
}

function appendTrustedHookState(
  configToml: string,
  hooksPath: string,
  settings: CodexHookSettings,
): string {
  const canonicalHooksPath = fs.realpathSync.native(hooksPath);
  const blocks: string[] = [];
  const windowsPath = usesWindowsPath(canonicalHooksPath);
  if (windowsPath) blocks.push('[hooks.state]');

  for (const [eventName, groups] of Object.entries(settings.hooks) as Array<
    [CodexHookEventName, CodexHookSettings['hooks'][CodexHookEventName]]
  >) {
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((hook, handlerIndex) => {
        if (hook.type !== 'command' || !hook.command) return;
        const suffix = `${CODEX_HOOK_EVENT_LABEL[eventName]}:${groupIndex}:${handlerIndex}`;
        const sourcePaths = windowsPath
          ? [canonicalHooksPath.replaceAll('/', '\\'), canonicalHooksPath.replaceAll('\\', '/')]
          : [canonicalHooksPath];
        const trustedHash = computeTrustedHash(eventName, hook, group.matcher);
        for (const sourcePath of [...new Set(sourcePaths)]) {
          const key = `${sourcePath}:${suffix}`;
          blocks.push(
            `[hooks.state.${formatHookStateKey(key)}]\n`
            + 'enabled = true\n'
            + `trusted_hash = "${trustedHash}"`,
          );
        }
      });
    });
  }

  const trimmed = configToml.trimEnd();
  return `${trimmed}${trimmed ? '\n\n' : ''}${blocks.join('\n\n')}\n`;
}

/**
 * per-terminal CODEX_HOME 오버레이 생성. 반환값을 자식 CODEX_HOME env로 준다.
 *
 *  - hooks.json  → 우리가 실제 파일로 작성(loopback 상태 훅). 실 hooks.json은 심링크 안 함.
 *  - config.toml → 스냅샷 복사(심링크 아님!). 심링크면 codex 런타임 기록(project trust/model)이
 *                  실 ~/.codex/config.toml을 오염시킨다. 복사면 codex 기록은 오버레이에만 남고
 *                  cleanup서 폐기. 사용자 설정(모델/샌드박스/project trust)은 읽기로 관통.
 *  - 그 외 전부  → 심링크(auth.json 라이브, sessions/ rollout 히스토리 관통 → codex resume 동작).
 *
 * per-launch 재생성이라 매 런치마다 config 스냅샷이 최신이고 심링크 stale이 없다.
 */
export function createCodexOverlay(terminalId: string): string {
  const overlayDir = overlayDirFor(terminalId);
  // stale 재생성: 이전 런치 잔여 제거(심링크는 unlink만 → 타깃 무손상).
  fs.rmSync(overlayDir, { recursive: true, force: true });
  fs.mkdirSync(overlayDir, { recursive: true });

  const systemHome = resolveCodexAccountHome();
  let configToml = '';
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(systemHome);
  } catch {
    logger.debug({ systemHome }, 'codex overlay: system CODEX_HOME missing, using empty overlay');
  }

  const isWin = getRuntimePlatform() === 'win32';
  for (const entry of entries) {
    if (entry === 'hooks.json') continue; // 우리 파일로 대체
    const source = path.join(systemHome, entry);
    const target = path.join(overlayDir, entry);
    try {
      if (entry === 'config.toml') {
        configToml = stripHookStateSections(fs.readFileSync(source, 'utf8'));
        continue;
      }
      const stat = fs.statSync(source); // dangling 심링크 스킵
      const type: fs.symlink.Type = stat.isDirectory() ? (isWin ? 'junction' : 'dir') : 'file';
      fs.symlinkSync(source, target, type);
    } catch (err) {
      logger.debug({ err, entry }, 'codex overlay: skip entry');
    }
  }

  const hookSettings = buildCodexHookSettings();
  const hooksPath = path.join(overlayDir, 'hooks.json');
  fs.writeFileSync(hooksPath, JSON.stringify(hookSettings, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(
    path.join(overlayDir, 'config.toml'),
    appendTrustedHookState(configToml, hooksPath, hookSettings),
    { mode: 0o600 },
  );

  logger.debug({ terminalId, overlayDir, systemHome }, 'codex overlay created');
  return overlayDir;
}

/** 터미널 종료/close 시 오버레이 dir 제거(심링크 unlink + 우리 파일 삭제, 실 CODEX_HOME 무손상). */
export function cleanupCodexOverlayForTerminal(terminalId: string): void {
  try {
    fs.rmSync(overlayDirFor(terminalId), { recursive: true, force: true });
  } catch (err) {
    logger.debug({ err, terminalId }, 'codex overlay cleanup skipped');
  }
}
