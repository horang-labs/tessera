function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

/**
 * Whether dropping `sources` onto folder `destination` (`""` is the root) would
 * do something. Dropping a folder onto itself or its own descendant is refused;
 * dropping onto the folder an entry already sits in is a no-op, not an error.
 */
export function resolveWorkspaceDrop(
  sources: readonly string[],
  destination: string,
): { allowed: boolean; movable: string[] } {
  const movable: string[] = [];
  for (const source of sources) {
    if (destination === source || destination.startsWith(`${source}/`)) {
      return { allowed: false, movable: [] };
    }
    if (parentOf(source) !== destination) movable.push(source);
  }
  return { allowed: movable.length > 0, movable };
}

/** A drag that carries files from outside the app, not a row from this tree. */
export function hasExternalFileDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

export interface DroppedFile {
  file: File;
  /** Path relative to the drop target; includes folders for a dropped tree. */
  path: string;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (resolve: (file: File) => void, reject: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (resolve: (entries: FileSystemEntryLike[]) => void, reject: (error: unknown) => void) => void;
  };
}

async function walkEntry(entry: FileSystemEntryLike, prefix: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    out.push({ file, path: `${prefix}${entry.name}` });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  for (;;) {
    // readEntries returns at most ~100 entries per call; an empty batch ends it.
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/** Flatten a drop from the OS, descending into dropped folders. */
export async function readDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const items = Array.from(dataTransfer.items ?? []);
  // Entries must be taken synchronously: the DataTransfer is cleared after the event.
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => (item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntryLike | null;
    }).webkitGetAsEntry?.() ?? null);
  if (entries.length > 0 && entries.every((entry) => entry)) {
    for (const entry of entries) await walkEntry(entry!, '', out);
    return out;
  }
  for (const file of Array.from(dataTransfer.files)) out.push({ file, path: file.name });
  return out;
}
