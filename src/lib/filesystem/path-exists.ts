import fs from 'node:fs/promises';
import { resolvePathForHostFilesystem } from './host-path';

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    // Fall through to WSL path handling below.
  }

  const resolvedCandidate = await resolvePathForHostFilesystem(candidate);
  if (resolvedCandidate === candidate) {
    return false;
  }

  try {
    await fs.access(resolvedCandidate);
    return true;
  } catch {
    return false;
  }
}
