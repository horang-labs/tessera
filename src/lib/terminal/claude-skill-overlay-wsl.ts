import { spawn } from 'node:child_process';
import logger from '@/lib/logger';
import { getWslGuestTesseraStateRoot } from '@/lib/electron-test-instance';
import { serializeClaudeTesseraPluginManifest } from './claude-skill-overlay';
import { buildPosixTesseraControlSkillMaterialization } from './tessera-control-skill';

const SAFE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OVERLAY_REPORT_LABEL = 'TESSERA_CLAUDE_PLUGIN';
const SCRIPT_TIMEOUT_MS = 20_000;

const guestOpsByTerminal = new Map<string, Promise<unknown>>();

function assertSafeTerminalId(terminalId: string): void {
  if (!SAFE_TERMINAL_ID.test(terminalId)) {
    throw new Error('Invalid terminal id for Claude WSL skill overlay');
  }
}

function chainGuestOp<T>(terminalId: string, operation: () => Promise<T>): Promise<T> {
  const previous = guestOpsByTerminal.get(terminalId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const tail = next.catch(() => undefined).then(() => {
    if (guestOpsByTerminal.get(terminalId) === tail) {
      guestOpsByTerminal.delete(terminalId);
    }
  });
  guestOpsByTerminal.set(terminalId, tail);
  return next;
}

export function buildWslClaudeSkillOverlayCreateScript(
  terminalId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertSafeTerminalId(terminalId);
  const pluginDir = resolveWslClaudeSkillOverlayDir(terminalId, env);
  const manifestB64 = Buffer.from(
    serializeClaudeTesseraPluginManifest(),
    'utf8',
  ).toString('base64');
  return [
    'set -eu',
    'umask 077',
    `plugin="${pluginDir}"`,
    'rm -rf "$plugin"',
    'mkdir -p "$plugin/.claude-plugin"',
    `printf '%s' '${manifestB64}' | base64 -d > "$plugin/.claude-plugin/plugin.json"`,
    'chmod 600 "$plugin/.claude-plugin/plugin.json"',
    'skills="$plugin/skills"',
    'mkdir -p "$skills"',
    ...buildPosixTesseraControlSkillMaterialization('skills', env),
    `printf '${OVERLAY_REPORT_LABEL}:%s\n' "$plugin"`,
  ].join('\n');
}

export function resolveWslClaudeSkillOverlayDir(
  terminalId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertSafeTerminalId(terminalId);
  return `${getWslGuestTesseraStateRoot(env)}/claude-overlay/${terminalId}`;
}

export function buildWslClaudeSkillOverlayCleanupScript(
  terminalId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertSafeTerminalId(terminalId);
  return `rm -rf "${resolveWslClaudeSkillOverlayDir(terminalId, env)}"`;
}

export function readWslClaudeSkillOverlayReport(stdout: string): string | undefined {
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
      finish(new Error(`Claude WSL skill overlay script timed out after ${SCRIPT_TIMEOUT_MS}ms`));
    }, SCRIPT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      finish(new Error(`Unable to launch wsl.exe for Claude skill overlay: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(
        `Claude WSL skill overlay script exited ${code}: ${stderr.trim().slice(0, 500)}`,
      ));
    });
    child.stdin.on('error', () => { /* EPIPE is reported by close/error. */ });
    child.stdin.end(script);
  });
}

export interface WslClaudeSkillOverlay {
  pluginDir: string;
  dispose: () => Promise<void>;
}

export async function createClaudeSkillOverlayInWsl(
  terminalId: string,
): Promise<WslClaudeSkillOverlay> {
  assertSafeTerminalId(terminalId);
  return chainGuestOp(terminalId, async () => {
    const stdout = await runWslScript(buildWslClaudeSkillOverlayCreateScript(terminalId));
    const pluginDir = readWslClaudeSkillOverlayReport(stdout);
    if (!pluginDir?.startsWith('/')) {
      throw new Error('Claude WSL skill overlay script did not report a guest path');
    }
    logger.debug({ terminalId, pluginDir }, 'Claude WSL skill overlay created');

    let disposePromise: Promise<void> | undefined;
    return {
      pluginDir,
      dispose: () => {
        disposePromise ??= chainGuestOp(terminalId, async () => {
          await runWslScript(buildWslClaudeSkillOverlayCleanupScript(terminalId));
        });
        return disposePromise;
      },
    };
  });
}
