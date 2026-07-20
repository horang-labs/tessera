/**
 * OS-native file drops (Finder / Windows Explorer) into the app.
 *
 * These differ fundamentally from in-app workspace-file drags: the OS fills
 * `dataTransfer.files` with real File objects but provides no path string, and
 * no custom MIME. The absolute host path can only be resolved through Electron's
 * `webUtils.getPathForFile`, exposed on `window.electronAPI.getDroppedFilePath`.
 *
 * Outside Electron (e.g. the browser dev server) that bridge is absent, so path
 * resolution yields nothing and the drop is silently ignored — the GUI is never
 * affected.
 */

/** Guard against pathological multi-file drops (mirrors Orca's limit). */
export const NATIVE_FILE_DROP_MAX_PATHS = 256;

interface ElectronFilePathBridge {
  getDroppedFilePath(file: File): string;
}

/**
 * True for a drag originating from the OS file manager. Such drags expose the
 * synthetic `'Files'` type; in-app drags only ever carry custom MIME types, so
 * this never collides with panel/session/workspace drags.
 *
 * Note: `dataTransfer.files` is empty during dragover for security — only the
 * `types` list is readable then, which is why this checks types alone.
 */
export function isNativeFileDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return dataTransfer.types.includes('Files');
}

/**
 * Resolve absolute host paths for OS-dropped files. Returns `[]` when running
 * outside Electron, when there are no files, or when the count exceeds the
 * guard limit. Only callable on `drop` (files are inaccessible during dragover).
 */
export function getNativeFileDropAbsolutePaths(
  dataTransfer: Pick<DataTransfer, 'files'>,
): string[] {
  const bridge = (
    window as Window & { electronAPI?: Partial<ElectronFilePathBridge> }
  ).electronAPI;
  if (typeof bridge?.getDroppedFilePath !== 'function') return [];

  const files = dataTransfer.files;
  if (!files || files.length === 0 || files.length > NATIVE_FILE_DROP_MAX_PATHS) {
    return [];
  }

  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = bridge.getDroppedFilePath(files[i]);
    if (path) paths.push(path);
  }
  return paths;
}
