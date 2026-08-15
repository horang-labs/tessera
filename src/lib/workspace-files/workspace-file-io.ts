/** Text files above this are served truncated, and refused on write. */
export const MAX_TEXT_FILE_BYTES = 512 * 1024;
export const MAX_RAW_FILE_BYTES = 25 * 1024 * 1024;
const FS_OPERATION_TIMEOUT_MS = 2_000;

/**
 * Same heuristic the read route serves `binary: true` from: a NUL byte in the
 * first 8 KB. Both sides must agree, or the editor would offer to save a
 * document the reader refused to hand over as text.
 */
export function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.byteLength, 8000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export class WorkspaceFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// fs calls against the workspace can block indefinitely on hung network,
// FUSE, or WSL mounts; respond with 504 instead of never responding. The
// underlying syscall cannot be cancelled, but the HTTP response must not
// wait for it.
export function withFsDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WorkspaceFileError(
        "filesystem_timeout",
        "The workspace filesystem did not respond in time",
        504,
      ));
    }, FS_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
