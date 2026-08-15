import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import logger from '@/lib/logger';
import {
  readCodexOverlayAccountHome,
  resolveCodexAccountHome,
  extractCodexOverlayTerminalId,
  writeCodexOverlayMarker,
} from '@/lib/codex-home';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import {
  buildCodexHookSettings,
  CODEX_HOOK_EVENT_LABEL,
  type CodexHookCommand,
  type CodexHookEventName,
  type CodexHookSettings,
} from './codex-hook-settings';
import type { HookCommandStyle } from './hook-command';
import {
  CODEX_TRUST_BASELINE_FILE,
  mergeCodexOverlayTrust,
  writeCodexConfigAtomically,
  writeCodexTrustBaseline,
} from './codex-trust-state';
import {
  materializeTesseraControlSkill,
  TESSERA_CONTROL_SKILL_NAME,
} from './tessera-control-skill';

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

/**
 * config.toml에 훅 trust 상태를 덧붙인다. canonicalHooksPath는 codex 런타임이
 * 보게 될 hooks.json의 canonical 경로 — 호스트 오버레이는 realpathSync, WSL 게스트
 * 오버레이는 게스트 안 readlink -f 결과를 넘긴다(호스트에서 게스트 경로를 resolve할
 * 수 없으므로 인자로 분리했다).
 */
export function appendTrustedHookState(
  configToml: string,
  canonicalHooksPath: string,
  settings: CodexHookSettings,
): string {
  const blocks: string[] = [];
  const windowsPath = usesWindowsPath(canonicalHooksPath);
  if (windowsPath && !/^\s*\[hooks\.state\]\s*(?:#.*)?$/m.test(configToml)) {
    blocks.push('[hooks.state]');
  }

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
 *  - config.toml → 스냅샷 복사(심링크 아님!). 일반 설정 변경은 cleanup서 폐기하고,
 *                  사용자가 Codex TUI에서 바꾼 project/hook trust만 실 config로 승격한다.
 *  - 그 외 전부  → 심링크(auth.json 라이브, sessions/ rollout 히스토리 관통 → codex resume 동작).
 *
 * per-launch 재생성이라 매 런치마다 config 스냅샷이 최신이고 심링크 stale이 없다.
 */
export function createCodexOverlay(
  terminalId: string,
  hookStyle: HookCommandStyle = 'posix',
  includeControlSkill = true,
): string {
  const overlayDir = overlayDirFor(terminalId);
  // stale 재생성: 이전 런치 잔여 제거(심링크는 unlink만 → 타깃 무손상).
  fs.rmSync(overlayDir, { recursive: true, force: true });
  fs.mkdirSync(overlayDir, { recursive: true });

  const systemHome = resolveCodexAccountHome();
  writeCodexOverlayMarker(overlayDir, systemHome);
  let configToml = '';
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(systemHome);
  } catch {
    logger.debug({ systemHome }, 'codex overlay: system CODEX_HOME missing, using empty overlay');
  }

  const isWin = getRuntimePlatform() === 'win32';
  for (const entry of entries) {
    if (
      entry === 'hooks.json'
      || entry === CODEX_TRUST_BASELINE_FILE
      || entry === 'skills'
    ) continue;
    const source = path.join(systemHome, entry);
    const target = path.join(overlayDir, entry);
    try {
      if (entry === 'config.toml') {
        configToml = fs.readFileSync(source, 'utf8');
        continue;
      }
      const stat = fs.statSync(source); // dangling 심링크 스킵
      const type: fs.symlink.Type = stat.isDirectory() ? (isWin ? 'junction' : 'dir') : 'file';
      try {
        fs.symlinkSync(source, target, type);
      } catch (err) {
        // win32 파일 심링크는 개발자 모드 OFF·비관리자에서 EPERM. 조용히 스킵하면
        // auth.json 없는 빈 CODEX_HOME이 되어 codex가 매번 로그인 화면을 띄운다 —
        // hardlink(무권한, in-place 갱신은 실 파일에 반영) → copy 순으로 폴백한다.
        if (!isWin || stat.isDirectory()) throw err;
        try {
          fs.linkSync(source, target);
          logger.warn({ entry }, 'codex overlay: symlink denied, fell back to hardlink');
        } catch {
          fs.copyFileSync(source, target);
          logger.warn({ entry }, 'codex overlay: symlink+hardlink denied, fell back to copy (writes will not reach the real CODEX_HOME)');
        }
      }
    } catch (err) {
      // 엔트리 하나가 빠지면 codex 동작이 조용히 달라진다(auth 없음=로그인 요구,
      // sessions 없음=resume 불가) — 원인 추적이 가능하게 warn으로 남긴다.
      logger.warn({ err, entry }, 'codex overlay: skip entry');
    }
  }

  const overlaySkillsDir = path.join(overlayDir, 'skills');
  fs.mkdirSync(overlaySkillsDir, { recursive: true, mode: 0o700 });
  let accountSkillEntries: string[] = [];
  try {
    accountSkillEntries = fs.readdirSync(path.join(systemHome, 'skills'));
  } catch (error) {
    if (fs.existsSync(path.join(systemHome, 'skills'))) {
      logger.warn({ error }, 'codex overlay: user skills directory could not be read');
    }
  }
  const accountSkillsDir = path.join(systemHome, 'skills');
  for (const entry of accountSkillEntries) {
    if (includeControlSkill && entry === TESSERA_CONTROL_SKILL_NAME) continue;
    const source = path.join(accountSkillsDir, entry);
    const target = path.join(overlaySkillsDir, entry);
    try {
      const stat = fs.statSync(source);
      const type: fs.symlink.Type = stat.isDirectory() ? (isWin ? 'junction' : 'dir') : 'file';
      try {
        fs.symlinkSync(source, target, type);
      } catch (error) {
        if (!isWin || stat.isDirectory()) throw error;
        try {
          fs.linkSync(source, target);
        } catch {
          fs.copyFileSync(source, target);
        }
      }
    } catch (error) {
      logger.warn({ error, entry }, 'codex overlay: user skill could not be mirrored');
    }
  }
  if (includeControlSkill) materializeTesseraControlSkill(overlaySkillsDir);

  const hookSettings = buildCodexHookSettings(hookStyle);
  const hooksPath = path.join(overlayDir, 'hooks.json');
  writeCodexTrustBaseline(overlayDir, configToml);
  fs.writeFileSync(hooksPath, JSON.stringify(hookSettings, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(
    path.join(overlayDir, 'config.toml'),
    appendTrustedHookState(configToml, fs.realpathSync.native(hooksPath), hookSettings),
    { mode: 0o600 },
  );

  logger.debug({ terminalId, overlayDir, systemHome }, 'codex overlay created');
  return overlayDir;
}

function promoteCodexOverlayTrust(overlayDir: string): void {
  const accountHome = readCodexOverlayAccountHome(overlayDir);
  if (!accountHome) return;
  const baselinePath = path.join(overlayDir, CODEX_TRUST_BASELINE_FILE);
  const overlayConfigPath = path.join(overlayDir, 'config.toml');
  const overlayHooksPath = path.join(overlayDir, 'hooks.json');
  if (!fs.existsSync(baselinePath) || !fs.existsSync(overlayConfigPath)) return;

  const accountConfigPath = path.join(accountHome, 'config.toml');
  const currentAccountConfig = fs.existsSync(accountConfigPath)
    ? fs.readFileSync(accountConfigPath, 'utf8')
    : '';
  const merged = mergeCodexOverlayTrust({
    baselineJson: fs.readFileSync(baselinePath, 'utf8'),
    finalOverlayConfig: fs.readFileSync(overlayConfigPath, 'utf8'),
    currentAccountConfig,
    managedHooksPath: fs.realpathSync.native(overlayHooksPath),
  });
  if (merged !== currentAccountConfig) {
    // Keep dotfile-managed config symlinks intact; atomic rename must target
    // the file behind the link rather than replacing the link itself.
    const writableConfigPath = fs.existsSync(accountConfigPath)
      ? fs.realpathSync.native(accountConfigPath)
      : accountConfigPath;
    writeCodexConfigAtomically(writableConfigPath, merged);
    logger.info({ accountHome }, 'codex overlay trust decisions promoted');
  }
}

function preserveCodexOverlaySessionsLink(overlayDir: string, accountHome: string): void {
  const source = path.join(accountHome, 'sessions');
  try {
    if (!fs.statSync(source).isDirectory()) return;
    fs.mkdirSync(overlayDir, { recursive: true, mode: 0o700 });
    const target = path.join(overlayDir, 'sessions');
    if (fs.existsSync(target)) return;
    fs.symlinkSync(source, target, getRuntimePlatform() === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    logger.debug({ err, overlayDir }, 'codex overlay resume link could not be preserved');
  }
}

/** Recreates a sessions-only alias for rollouts recorded by an older overlay. */
export function repairCodexOverlayResumePath(transcriptPath: string): void {
  const terminalId = extractCodexOverlayTerminalId(transcriptPath);
  if (!terminalId) return;
  preserveCodexOverlaySessionsLink(overlayDirFor(terminalId), resolveCodexAccountHome());
}

/** 종료 직전 trust 결정만 승격한 뒤 resume 링크를 제외한 overlay를 제거한다. */
export function cleanupCodexOverlayForTerminal(terminalId: string): void {
  const overlayDir = overlayDirFor(terminalId);
  const accountHome = readCodexOverlayAccountHome(overlayDir) ?? resolveCodexAccountHome();
  try {
    promoteCodexOverlayTrust(overlayDir);
  } catch (err) {
    logger.warn({ err, terminalId }, 'codex overlay trust promotion skipped');
  }
  try {
    fs.rmSync(overlayDir, { recursive: true, force: true });
    preserveCodexOverlaySessionsLink(overlayDir, accountHome);
  } catch (err) {
    logger.debug({ err, terminalId }, 'codex overlay cleanup skipped');
  }
}
