import fs from 'fs';
import path from 'path';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import logger from '@/lib/logger';
import { buildOpenCodeHookPluginSource } from './opencode-hook-plugin';
import { materializeTesseraControlSkill } from './tessera-control-skill';
import { mirrorOpenCodeConfigIntoOverlay } from '@/lib/cli/providers/opencode/config-overlay';
import { removeOverlayTreeSafely } from '@/lib/filesystem/overlay-filesystem';

const SAFE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface OpenCodeOverlay {
  configDir: string;
  dispose: () => void;
}

/**
 * Create a unique config-directory layer for one OpenCode invocation.
 * OPENCODE_CONFIG_DIR is additive, so the user's global config, project config,
 * .opencode directory, and their plugins continue to load unchanged.
 */
export function createOpenCodeOverlay(
  terminalId: string,
  includeControlSkill = true,
  existingConfigDir = process.env.OPENCODE_CONFIG_DIR,
): OpenCodeOverlay {
  if (!SAFE_TERMINAL_ID.test(terminalId)) {
    throw new Error('Invalid terminal id for OpenCode overlay');
  }

  const baseDir = getTesseraDataPath('opencode-overlay');
  fs.mkdirSync(baseDir, { recursive: true });
  const configDir = fs.mkdtempSync(path.join(baseDir, `${terminalId}-`));
  try {
    const pluginsDir = path.join(configDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(pluginsDir, 'tessera-lifecycle.js'),
      buildOpenCodeHookPluginSource(),
      { mode: 0o600 },
    );
    if (includeControlSkill) {
      materializeTesseraControlSkill(path.join(configDir, 'skills'));
    }
    mirrorOpenCodeConfigIntoOverlay(existingConfigDir, configDir);
  } catch (error) {
    removeOverlayTreeSafely(configDir);
    throw error;
  }

  let disposed = false;
  return {
    configDir,
    dispose: () => {
      if (disposed) return;
      try {
        removeOverlayTreeSafely(configDir);
        disposed = true;
      } catch (error) {
        logger.debug({ error, configDir }, 'OpenCode overlay cleanup skipped');
      }
    },
  };
}
