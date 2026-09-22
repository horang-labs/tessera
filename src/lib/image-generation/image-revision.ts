import { createHash } from 'node:crypto';
import type { ImageLocator } from './traces';

/** Cache files are named by content hash. Revision calculation reads metadata only. */
export function imageRevision(locator: ImageLocator): string {
  const hash = createHash('sha256').update(locator.kind).update('\0');
  if (locator.kind === 'inline') {
    hash.update(locator.mimeType).update('\0');
    // Non-indexed providers may still use inline locators; avoid a whole-image
    // temporary UTF-8 buffer during hashing.
    for (let offset = 0; offset < locator.data.length; offset += 64 * 1024) hash.update(locator.data.slice(offset, offset + 64 * 1024));
  } else {
    hash.update(locator.path);
    if (locator.kind === 'transcript') hash.update(`\0${locator.offset}:${locator.length}:${locator.dataUrl}:${locator.mimeType ?? ''}`);
  }
  return hash.digest('hex').slice(0, 24);
}
