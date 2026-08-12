import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execCli, type ExecResult } from './cli-exec';
import type { AgentEnvironment } from '@/lib/settings/types';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';

export const TESSERA_CLI_SKILL_INSTALL_COMMAND =
  'npx skills add https://github.com/horang-labs/tessera --skill tessera-cli --global';
export const TESSERA_CLI_SKILL_UPDATE_COMMAND = 'npx skills update tessera-cli --global';

export type TesseraCliSkillState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'setup-failed'
  | 'conflict';

export interface TesseraCliSkillStatus {
  state: TesseraCliSkillState;
  agentEnvironment: AgentEnvironment;
  agents: string[];
  command: string;
  message?: string;
}

interface SkillsCliEntry {
  name?: unknown;
  path?: unknown;
  agents?: unknown;
  source?: unknown;
  sourceUrl?: unknown;
}

type InstallationInspection = 'current' | 'stale' | 'modified';

interface ManagerOptions {
  exec?: typeof execCli;
  inspectInstallation?: (
    entry: SkillsCliEntry,
    environment: AgentEnvironment,
  ) => Promise<InstallationInspection>;
}

function normalizeSource(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\.git\/?$/, '').replace(/\/$/, '')
    : '';
}

function isTesseraSource(entry: SkillsCliEntry): boolean {
  const sources = [normalizeSource(entry.sourceUrl), normalizeSource(entry.source)];
  return sources.some((source) => (
    source === 'https://github.com/horang-labs/tessera'
    || source === 'github.com/horang-labs/tessera'
    || source === 'horang-labs/tessera'
  ));
}

function gitBlobHash(bytes: Buffer): Buffer {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest();
}

async function gitTreeHash(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const records = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    const mode = entry.isDirectory() ? '40000' : (await stat(fullPath)).mode & 0o111 ? '100755' : '100644';
    const hash = entry.isDirectory()
      ? Buffer.from(await gitTreeHash(fullPath), 'hex')
      : gitBlobHash(await readFile(fullPath));
    return { name: entry.name, record: Buffer.concat([Buffer.from(`${mode} ${entry.name}\0`), hash]) };
  }));
  records.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  const body = Buffer.concat(records.map(({ record }) => record));
  return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
}

async function inspectStandardInstallation(
  entry: SkillsCliEntry,
  environment: AgentEnvironment,
): Promise<InstallationInspection> {
  if (typeof entry.path !== 'string' || !entry.path.trim()) return 'modified';
  const installationPath = await resolveAgentReportedPath(entry.path, environment);
  const skillsRoot = path.dirname(path.dirname(installationPath));
  const lock = JSON.parse(
    await readFile(path.join(skillsRoot, '.skill-lock.json'), 'utf8'),
  ) as { skills?: Record<string, { skillFolderHash?: unknown }> };
  const expected = lock.skills?.['tessera-cli']?.skillFolderHash;
  if (typeof expected !== 'string') return 'modified';
  const observed = await gitTreeHash(installationPath);
  if (observed !== expected) return 'modified';
  const appRoot = process.env.TESSERA_APP_ROOT || process.cwd();
  const current = await gitTreeHash(path.join(appRoot, 'skills', 'tessera-cli'));
  return current === observed ? 'current' : 'stale';
}

function parseEntries(result: ExecResult): SkillsCliEntry[] {
  if (!result.ok) throw new Error(result.stderr.trim() || 'The Skills CLI status check failed.');
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error('The Skills CLI returned an invalid status response.');
  return parsed.filter((entry): entry is SkillsCliEntry => typeof entry === 'object' && entry !== null);
}

export function createTesseraCliSkillManager(options: ManagerOptions = {}) {
  const execute = options.exec ?? execCli;
  const inspectInstallation = options.inspectInstallation ?? inspectStandardInstallation;

  return {
    async inspect(environment: AgentEnvironment): Promise<TesseraCliSkillStatus> {
      try {
        const result = await execute(
          'npx',
          ['--yes', 'skills', 'list', '--global', '--json'],
          environment,
          30_000,
        );
        const entries = parseEntries(result).filter(({ name }) => name === 'tessera-cli');
        if (entries.length === 0) {
          return { state: 'not-installed', agentEnvironment: environment, agents: [], command: TESSERA_CLI_SKILL_INSTALL_COMMAND };
        }
        const entry = entries[0];
        const agents = Array.isArray(entry.agents)
          ? entry.agents.filter((agent): agent is string => typeof agent === 'string')
          : [];
        if (entries.length !== 1 || !isTesseraSource(entry)) {
          return {
            state: 'conflict', agentEnvironment: environment, agents, command: TESSERA_CLI_SKILL_INSTALL_COMMAND,
            message: 'A tessera-cli skill from another source is installed. Tessera did not change it.',
          };
        }
        const inspection = await inspectInstallation(entry, environment);
        if (inspection === 'modified') {
          return {
            state: 'conflict', agentEnvironment: environment, agents, command: TESSERA_CLI_SKILL_INSTALL_COMMAND,
            message: 'The managed tessera-cli skill was modified outside the Skills CLI. Tessera did not overwrite it.',
          };
        }
        return {
          state: inspection === 'stale' ? 'update-available' : 'installed',
          agentEnvironment: environment,
          agents,
          command: inspection === 'stale' ? TESSERA_CLI_SKILL_UPDATE_COMMAND : TESSERA_CLI_SKILL_INSTALL_COMMAND,
        };
      } catch (error) {
        return {
          state: 'setup-failed', agentEnvironment: environment, agents: [], command: TESSERA_CLI_SKILL_INSTALL_COMMAND,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async remove(environment: AgentEnvironment): Promise<TesseraCliSkillStatus> {
      const before = await this.inspect(environment);
      if (before.state === 'conflict') return before;
      if (before.state === 'not-installed') return before;
      if (before.state === 'setup-failed') return before;
      const result = await execute(
        'npx',
        ['--yes', 'skills', 'remove', 'tessera-cli', '--global', '-y'],
        environment,
        60_000,
      );
      if (!result.ok) {
        return { ...before, state: 'setup-failed', message: result.stderr.trim() || 'Skill removal failed.' };
      }
      return this.inspect(environment);
    },
  };
}

export const tesseraCliSkillManager = createTesseraCliSkillManager();
