import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export interface ImageCheckpoint {
  path: string;
  identity: string;
  offset: number;
  size: number;
  mtimeMs: number;
  boundary: string;
}

async function boundaryHash(file: fs.FileHandle, offset: number): Promise<string> {
  const buffer = Buffer.alloc(Math.min(256, offset));
  const { bytesRead } = await file.read(buffer, 0, buffer.length, offset - buffer.length);
  return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
}

/** Byte offsets, complete JSONL records, bounded batches; never retain a whole transcript. */
export async function readImageTranscriptBatch(
  path: string,
  previous: ImageCheckpoint | undefined,
  reset: () => void,
  consume: (line: string, offset: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ checkpoint: ImageCheckpoint; more: boolean; bytesRead: number }> {
  const file = await fs.open(path, 'r');
  try {
    const stat = await file.stat();
    // WSL's Windows file server can report mtime as birthtime. Including it
    // would misclassify every append as a replacement and rescan from zero.
    const identity = `${stat.dev}:${stat.ino}`;
    let offset = previous?.offset ?? 0;
    const valid = previous && previous.path === path && previous.identity === identity && stat.size >= offset
      && previous.boundary === await boundaryHash(file, offset)
      && !(stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs);
    if (!valid) { offset = 0; reset(); }
    const start = offset;
    let more = false;
    if (stat.size > offset) {
      let readPosition = offset;
      let fragments: Buffer[] = [];
      let length = 0;
      const started = Date.now();
        outer: while (readPosition < stat.size) {
          const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, stat.size - readPosition));
          const read = await file.read(chunk, 0, chunk.length, readPosition);
          if (!read.bytesRead) break;
          readPosition += read.bytesRead;
          const buffer = chunk.subarray(0, read.bytesRead);
          let cursor = 0;
          while (cursor < buffer.length) {
            if (signal?.aborted) break outer;
            const newline = buffer.indexOf(10, cursor);
            const end = newline === -1 ? buffer.length : newline + 1;
            const part = buffer.subarray(cursor, end);
            fragments.push(part);
            length += part.length;
            // Fail explicitly instead of retaining unbounded malformed/huge JSON records.
            if (length > 96 * 1024 * 1024) throw new Error('Image transcript record exceeds 96 MiB');
            cursor = end;
            if (newline === -1) continue;
            const line = Buffer.concat(fragments, length).toString('utf8');
            await consume(line, offset);
            offset += length;
            fragments = [];
            length = 0;
            if (offset - start >= 32 * 1024 * 1024 || Date.now() - started >= 250) {
              more = offset < stat.size;
              break outer;
            }
          }
        }
    }
    return { checkpoint: { path, identity, offset, size: stat.size, mtimeMs: stat.mtimeMs, boundary: await boundaryHash(file, offset) },
      more, bytesRead: offset - start };
  } finally { await file.close(); }
}
