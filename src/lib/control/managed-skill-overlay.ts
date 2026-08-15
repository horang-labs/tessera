import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getWslGuestTesseraStateRoot } from '@/lib/electron-test-instance';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import {
  buildPosixTesseraControlSkillMaterialization,
  materializeTesseraControlSkill,
} from '@/lib/terminal/tessera-control-skill';
import { serializeClaudeTesseraPluginManifest } from '@/lib/terminal/claude-skill-overlay';
import { removeOverlayTreeSafely } from '@/lib/filesystem/overlay-filesystem';

const SAFE_LAUNCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPORT_LABEL = 'TESSERA_MANAGED_SKILL_OVERLAY';
const WSL_TIMEOUT_MS = 20_000;
const preparedNativeRoots = new Set<string>();
const preparedWslRoots = new Map<string, Promise<void>>();

export interface ManagedSkillOverlay {
  rootDir: string;
  skillsDir: string;
  dispose(): Promise<void>;
}

export function createManagedSkillOverlay(launchId: string): ManagedSkillOverlay {
  assertSafeLaunchId(launchId);
  const baseDir = getTesseraDataPath('managed-skill-overlay');
  if (!preparedNativeRoots.has(baseDir)) {
    removeOverlayTreeSafely(baseDir);
    preparedNativeRoots.add(baseDir);
  }
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const containerDir = fs.mkdtempSync(path.join(baseDir, `${launchId}-`));
  try {
    writeOverlay(containerDir);
  } catch (error) {
    removeOverlayTreeSafely(containerDir);
    throw error;
  }

  let disposed = false;
  return {
    rootDir: path.join(containerDir, 'plugin'),
    skillsDir: path.join(containerDir, 'skills'),
    async dispose() {
      if (disposed) return;
      disposed = true;
      removeOverlayTreeSafely(containerDir);
    },
  };
}

export async function createManagedSkillOverlayInWsl(
  launchId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedSkillOverlay> {
  await prepareManagedSkillOverlayRootInWsl(env);
  const stdout = await runWslScript(buildWslManagedSkillOverlayCreateScript(launchId, env));
  const containerDir = readReport(stdout);
  if (!containerDir?.startsWith('/')) {
    throw new Error('Managed skill overlay script did not report an absolute guest path.');
  }

  let disposed = false;
  return {
    rootDir: `${containerDir}/plugin`,
    skillsDir: `${containerDir}/skills`,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await runWslScript(`set -eu\nrm -rf ${quotePosix(containerDir)}`);
    },
  };
}

async function prepareManagedSkillOverlayRootInWsl(env: NodeJS.ProcessEnv): Promise<void> {
  const stateRoot = getWslGuestTesseraStateRoot(env);
  const existing = preparedWslRoots.get(stateRoot);
  if (existing) return existing;
  const pending = runWslScript(buildWslManagedSkillOverlayRootPreparationScript(env))
    .then(() => undefined)
    .catch((error) => {
      if (preparedWslRoots.get(stateRoot) === pending) preparedWslRoots.delete(stateRoot);
      throw error;
    });
  preparedWslRoots.set(stateRoot, pending);
  return pending;
}

export function buildWslManagedSkillOverlayRootPreparationScript(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateRoot = getWslGuestTesseraStateRoot(env);
  return [
    'set -eu',
    'umask 077',
    `state_root="${stateRoot}"`,
    'managed_root="$state_root/managed-skill-overlay"',
    'rm -rf "$managed_root"',
    'mkdir -p "$managed_root"',
  ].join('\n');
}

export function buildWslManagedSkillOverlayCreateScript(
  launchId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertSafeLaunchId(launchId);
  const stateRoot = getWslGuestTesseraStateRoot(env);
  return [
    'set -eu',
    'umask 077',
    `state_root="${stateRoot}"`,
    'managed_root="$state_root/managed-skill-overlay"',
    'mkdir -p "$managed_root"',
    `overlay=$(mktemp -d "$managed_root/${launchId}-XXXXXX")`,
    'plugin="$overlay/plugin"',
    'mkdir -p "$plugin/.claude-plugin" "$plugin/skills" "$overlay/skills"',
    `printf '%s' '${Buffer.from(serializeClaudeTesseraPluginManifest(), 'utf8').toString('base64')}' | base64 -d > "$plugin/.claude-plugin/plugin.json"`,
    'chmod 600 "$plugin/.claude-plugin/plugin.json"',
    'skills="$plugin/skills"',
    ...buildPosixTesseraControlSkillMaterialization('skills', env),
    'skills="$overlay/skills"',
    ...buildPosixTesseraControlSkillMaterialization('skills', env),
    `printf '${REPORT_LABEL}:%s\n' "$overlay"`,
  ].join('\n');
}

function writeOverlay(containerDir: string): void {
  const pluginDir = path.join(containerDir, 'plugin');
  const manifestDir = path.join(pluginDir, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    serializeClaudeTesseraPluginManifest(),
    { mode: 0o600 },
  );
  materializeTesseraControlSkill(path.join(pluginDir, 'skills'));
  materializeTesseraControlSkill(path.join(containerDir, 'skills'));
}

function assertSafeLaunchId(launchId: string): void {
  if (!SAFE_LAUNCH_ID.test(launchId)) {
    throw new Error('Invalid managed skill overlay launch id.');
  }
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readReport(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(`${REPORT_LABEL}:`)) continue;
    const value = line.slice(REPORT_LABEL.length + 1).replace(/\r$/, '').trim();
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
      finish(new Error(`Managed skill overlay script timed out after ${WSL_TIMEOUT_MS}ms`));
    }, WSL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(new Error(`Unable to launch wsl.exe: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Managed skill overlay script exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}
