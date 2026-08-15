import fs from 'node:fs';
import path from 'node:path';

export function mirrorOverlayEntry(sourcePath: string, targetPath: string): void {
  const stats = fs.lstatSync(sourcePath);
  const directory = stats.isDirectory()
    || (stats.isSymbolicLink() && fs.statSync(sourcePath).isDirectory());
  if (process.platform === 'win32') {
    if (directory) {
      fs.symlinkSync(sourcePath, targetPath, 'junction');
      return;
    }
    try {
      fs.linkSync(sourcePath, targetPath);
    } catch {
      fs.copyFileSync(sourcePath, targetPath);
    }
    return;
  }
  fs.symlinkSync(sourcePath, targetPath, directory ? 'dir' : 'file');
}

/** Remove an overlay without ever descending through a symlink or Windows junction. */
export function removeOverlayTreeSafely(targetPath: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    try { fs.unlinkSync(targetPath); } catch { /* best effort */ }
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    removeOverlayTreeSafely(path.join(targetPath, entry.name));
  }
  try { fs.rmdirSync(targetPath); } catch { /* best effort */ }
}
