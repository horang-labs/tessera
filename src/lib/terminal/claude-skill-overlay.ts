import fs from 'node:fs';
import path from 'node:path';
import logger from '@/lib/logger';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { materializeTesseraControlSkill } from './tessera-control-skill';

const SAFE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ClaudeSkillOverlay {
  pluginDir: string;
  dispose: () => void;
}

export const CLAUDE_TESSERA_PLUGIN_MANIFEST = {
  name: 'tessera',
  description: 'Operate Tessera resources through the injected control CLI',
} as const;

export function serializeClaudeTesseraPluginManifest(): string {
  return `${JSON.stringify(CLAUDE_TESSERA_PLUGIN_MANIFEST, null, 2)}\n`;
}

export function createClaudeSkillOverlay(terminalId: string): ClaudeSkillOverlay {
  if (!SAFE_TERMINAL_ID.test(terminalId)) {
    throw new Error('Invalid terminal id for Claude skill overlay');
  }

  const baseDir = getTesseraDataPath('claude-overlay');
  fs.mkdirSync(baseDir, { recursive: true });
  const pluginDir = fs.mkdtempSync(path.join(baseDir, `${terminalId}-`));
  try {
    const manifestDir = path.join(pluginDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      serializeClaudeTesseraPluginManifest(),
      { mode: 0o600 },
    );
    materializeTesseraControlSkill(path.join(pluginDir, 'skills'));
  } catch (error) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  return {
    pluginDir,
    dispose: () => {
      if (disposed) return;
      try {
        fs.rmSync(pluginDir, { recursive: true, force: true });
        disposed = true;
      } catch (error) {
        logger.debug({ error, pluginDir }, 'Claude skill overlay cleanup skipped');
      }
    },
  };
}
