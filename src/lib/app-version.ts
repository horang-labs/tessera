import fs from 'node:fs';
import path from 'node:path';

export function readAppVersion(appRoot: string): string {
  const parsed = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error('Tessera package version is unavailable');
  }
  return parsed.version.trim();
}
