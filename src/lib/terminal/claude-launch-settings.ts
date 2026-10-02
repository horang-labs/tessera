import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';

/** Claude accepts a regular JSON file for --settings. Keep observer bytes off the Windows
 * command line; this server-owned file is translated into the CLI's filesystem spelling.
 * Each launch owns an exclusive versioned copy, retained until its runtime disposer runs.
 */
export function createClaudeLaunchSettingsFile(settingsJson: string, owner: {
  userId: string; sessionId: string; terminalId: string; agentEnvironment: AgentEnvironment;
}): { settingsPath: string; dispose(): void } {
  if (!owner.userId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner.terminalId)) throw new Error('Invalid Claude launch owner');
  if (Buffer.byteLength(settingsJson, 'utf8') > 2 * 1024 * 1024) throw new Error('Claude launch settings exceed 2 MiB');
  const settings: unknown = JSON.parse(settingsJson);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude launch settings must be an object');
  const scope = createHash('sha256').update(JSON.stringify(owner)).digest('hex').slice(0, 32);
  const base = getTesseraDataPath('claude-launch-settings', 'v1');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(base, scope + '-'));
  let settingsPath: string;
  try {
    const file = path.join(directory, 'settings-v1.json');
    fs.writeFileSync(file, settingsJson, { flag: 'wx', mode: 0o600 });
    settingsPath = formatPathForAgentDisplay(fs.realpathSync.native(file), owner.agentEnvironment);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return { settingsPath, dispose: () => {
    if (disposed) return;
    fs.rmSync(directory, { recursive: true, force: true });
    disposed = true;
  } };
}
