import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import { resolveCodexAccountOverlayPath } from '@/lib/codex-home';
import { isBridgedAgentEnvironment, resolveAgentHomeFilesystemPath } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { ImageLocator } from './traces';

export function imageSessionCacheDirectory(sessionId: string): string {
  return getTesseraDataPath('cache', 'image-generations', createHash('sha256').update(sessionId).digest('hex'));
}

/** Own the file: a CLI overlay or original generated file can disappear later. */
export async function cacheImageFile(sessionId: string, locator: ImageLocator, environment: AgentEnvironment): Promise<ImageLocator | undefined> {
  const maxBytes = 25 * 1024 * 1024;
  let bytes: Buffer;
  let extension: string;
  if (locator.kind === 'inline') {
    if (locator.data.length > Math.ceil(maxBytes * 4 / 3)) return undefined;
    bytes = Buffer.from(locator.data, 'base64');
    extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
      'image/avif': '.avif', 'image/bmp': '.bmp', 'image/svg+xml': '.svg' } as Record<string, string>)[locator.mimeType] ?? '.png';
  } else {
    let source = locator.path;
    if (locator.kind === 'path') {
      source = await resolveAgentReportedPath(source, environment);
      source = resolveCodexAccountOverlayPath(source, isBridgedAgentEnvironment(environment)
        ? { env: { NODE_ENV: process.env.NODE_ENV }, homeDir: await resolveAgentHomeFilesystemPath(environment) } : undefined);
    }
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    bytes = await fs.readFile(source);
    extension = path.extname(source).toLowerCase();
    if (!/^\.(png|jpe?g|webp|gif|avif|bmp|svg)$/.test(extension)) return undefined;
  }
  if (!bytes.length || bytes.length > maxBytes) return undefined;
  const directory = imageSessionCacheDirectory(sessionId);
  const target = path.join(directory, `${createHash('sha256').update(bytes).digest('hex')}${extension}`);
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.stat(target).catch(() => undefined))?.size === bytes.length) return { kind: 'cache', path: target };
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return { kind: 'cache', path: target };
}
