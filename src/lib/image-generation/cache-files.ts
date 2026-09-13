import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import { resolveCodexAccountOverlayPath } from '@/lib/codex-home';
import { isBridgedAgentEnvironment, resolveAgentHomeFilesystemPath } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { ImageLocator } from './traces';

const MAX_BYTES = 25 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/svg+xml': '.svg' };

export function imageSessionCacheDirectory(sessionId: string): string {
  return getTesseraDataPath('cache', 'image-generations', createHash('sha256').update(sessionId).digest('hex'));
}

async function* fileChunks(filePath: string, offset = 0, length?: number): AsyncGenerator<Buffer> {
  const file = await fs.open(filePath, 'r');
  try {
    const end = offset + (length ?? (await file.stat()).size);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - offset));
    while (offset < end) {
      // Consumers finish decoding/writing each yielded chunk before requesting the next.
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (!bytesRead) throw new Error('Image source ended before its recorded span');
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally { await file.close(); }
}

/** Decode a JSON-string span in bounded pieces, including escapes split across chunks. */
async function* transcriptText(locator: Extract<ImageLocator, { kind: 'transcript' }>): AsyncGenerator<string> {
  let carry = '';
  for await (const bytes of fileChunks(locator.path, locator.offset, locator.length)) {
    const raw = carry + bytes.toString('utf8');
    let end = raw.length;
    const partialUnicode = raw.match(/\\u[0-9a-fA-F]{0,3}$/);
    if (partialUnicode) end -= partialUnicode[0].length;
    else {
      let slashes = 0;
      for (let i = end - 1; i >= 0 && raw[i] === '\\'; i--) slashes++;
      if (slashes % 2) end--;
    }
    carry = raw.slice(end);
    if (end) yield JSON.parse(`"${raw.slice(0, end)}"`) as string;
  }
  if (carry) throw new Error('Incomplete image JSON escape');
}

/** Own each image without buffering the entire encoded or decoded file. */
export async function cacheImageFile(sessionId: string, locator: ImageLocator, environment: AgentEnvironment): Promise<ImageLocator | undefined> {
  const directory = imageSessionCacheDirectory(sessionId);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const output = await fs.open(temporary, 'wx');
  const hash = createHash('sha256');
  let size = 0;
  let extension = '.png';
  const write = async (bytes: Buffer) => {
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error('Image exceeds cache size limit');
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.length) offset += (await output.write(bytes, offset, bytes.length - offset)).bytesWritten;
  };
  try {
    if (locator.kind === 'inline' || locator.kind === 'transcript') {
      if (locator.kind === 'inline' && locator.data.length > Math.ceil(MAX_BYTES * 4 / 3)) return undefined;
      extension = EXTENSIONS[locator.mimeType ?? 'image/png'] ?? '.png';
      const text = locator.kind === 'transcript' ? transcriptText(locator) : (async function* () {
        for (let offset = 0; offset < locator.data.length; offset += 64 * 1024) yield locator.data.slice(offset, offset + 64 * 1024);
      })();
      let header = locator.kind === 'transcript' && locator.dataUrl;
      let pending = '';
      for await (let chunk of text) {
        if (header) {
          pending += chunk;
          const comma = pending.indexOf(',');
          if (comma < 0) { if (pending.length > 256) throw new Error('Invalid image data URL'); continue; }
          const mime = pending.slice(0, comma).match(/^data:([^;,]+);base64$/)?.[1];
          if (!mime) throw new Error('Invalid image data URL');
          extension = EXTENSIONS[mime] ?? '.png';
          chunk = pending.slice(comma + 1); pending = ''; header = false;
        }
        pending += chunk.replace(/\s/g, '');
        if (/[^A-Za-z0-9+/=]/.test(pending)) throw new Error('Invalid image base64');
        const complete = pending.length - pending.length % 4;
        if (complete) { await write(Buffer.from(pending.slice(0, complete), 'base64')); pending = pending.slice(complete); }
      }
      if (header) return undefined;
      if (pending) await write(Buffer.from(pending, 'base64'));
    } else {
      let source = locator.path;
      if (locator.kind === 'path') {
        if (source.startsWith('file://')) {
          const url = new URL(source);
          const pathname = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/, '');
          source = url.hostname ? `//${url.hostname}${pathname}` : pathname;
        }
        source = await resolveAgentReportedPath(source, environment);
        source = resolveCodexAccountOverlayPath(source, isBridgedAgentEnvironment(environment)
          ? { env: { NODE_ENV: process.env.NODE_ENV }, homeDir: await resolveAgentHomeFilesystemPath(environment) } : undefined);
      }
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      extension = path.extname(source).toLowerCase();
      if (!/^\.(png|jpe?g|webp|gif|avif|bmp|svg)$/.test(extension)) return undefined;
      for await (const bytes of fileChunks(source, 0, stat.size)) await write(bytes);
    }
    if (!size) return undefined;
    await output.close();
    const target = path.join(directory, `${hash.digest('hex')}${extension}`);
    if ((await fs.stat(target).catch(() => undefined))?.size !== size) await fs.rename(temporary, target);
    return { kind: 'cache', path: target };
  } finally {
    await output.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}
