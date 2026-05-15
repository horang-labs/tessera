import fs from 'node:fs/promises';
import { resolveBrowsePath } from './path-environment';
import { getRuntimePlatform } from '../system/runtime-platform';

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    // Fall through to WSL path handling below.
  }

  if (getRuntimePlatform() !== 'win32' || !candidate.startsWith('/')) {
    return false;
  }

  try {
    const resolved = await resolveBrowsePath(candidate, 'wsl');
    await fs.access(resolved.filesystemPath);
    return true;
  } catch {
    return false;
  }
}
