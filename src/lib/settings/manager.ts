import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { UserSettings } from './types';
import { DEFAULT_SETTINGS } from './defaults';
import { normalizeUserSettings } from './provider-defaults';
import logger from '../logger';

const SETTINGS_DIR = path.join(os.homedir(), '.tessera', 'settings');

export class SettingsManager {
  private static async ensureDir() {
    await fs.mkdir(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }

  private static getFilePath(userId: string): string {
    return path.join(SETTINGS_DIR, `${userId}.json`);
  }

  static async load(userId: string, options: { silent?: boolean } = {}): Promise<UserSettings> {
    try {
      await this.ensureDir();
      const filePath = this.getFilePath(userId);
      const content = await fs.readFile(filePath, 'utf-8');
      const settings = normalizeUserSettings(JSON.parse(content));

      if (!options.silent) {
        logger.info({ userId }, 'Settings loaded');
      }
      return settings;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        if (!options.silent) {
          logger.info({ userId }, 'Settings file not found, returning defaults');
        }
        return DEFAULT_SETTINGS;
      }
      logger.error({ userId, error }, 'Failed to load settings');
      return DEFAULT_SETTINGS;
    }
  }

  static async save(userId: string, settings: UserSettings): Promise<void> {
    let tempFilePath: string | null = null;

    try {
      await this.ensureDir();
      const filePath = this.getFilePath(userId);
      tempFilePath = path.join(
        SETTINGS_DIR,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
      );
      const content = JSON.stringify(normalizeUserSettings(settings), null, 2);

      await fs.writeFile(tempFilePath, content, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await fs.rename(tempFilePath, filePath);
      tempFilePath = null;

      logger.info({ userId }, 'Settings saved');
    } catch (error) {
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(() => undefined);
      }
      logger.error({ userId, error }, 'Failed to save settings');
      throw error;
    }
  }

  static async reset(userId: string): Promise<UserSettings> {
    const defaults = {
      ...DEFAULT_SETTINGS,
      lastModified: new Date().toISOString(),
    };

    await this.save(userId, defaults);
    logger.info({ userId }, 'Settings reset to defaults');

    return defaults;
  }
}
