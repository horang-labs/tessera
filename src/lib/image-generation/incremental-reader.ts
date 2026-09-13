import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readMetadataRecords } from '../../../runtime/image-record-reader.cjs';

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
  consume: (record: Record<string, unknown>, offset: number) => Promise<void>,
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
    const batch = await readMetadataRecords(path, { start: offset, end: stat.size, maxBytes: 32 * 1024 * 1024, maxMs: 250, signal },
      async (record, originalOffset) => {
        delete record.__tesseraRecordOffset;
        await consume(record, originalOffset);
      });
    offset = batch.offset;
    return { checkpoint: { path, identity, offset, size: stat.size, mtimeMs: stat.mtimeMs, boundary: await boundaryHash(file, offset) },
      more: batch.more, bytesRead: batch.bytesRead };
  } finally { await file.close(); }
}
