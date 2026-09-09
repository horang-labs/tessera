import type { WorkspaceTarget } from '@/types/worktree';

const WORKSPACE_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function extensionOf(filePath: string): string {
  const slashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dotIndex = filePath.lastIndexOf('.');
  return dotIndex > slashIndex ? filePath.slice(dotIndex + 1).toLowerCase() : '';
}

export function inferWorkspaceFileContentType(filePath: string): string {
  return WORKSPACE_IMAGE_MIME_BY_EXTENSION[extensionOf(filePath)]
    ?? 'application/octet-stream';
}

export function isWorkspaceImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

export function buildWorkspaceRawFileUrl(
  target: WorkspaceTarget,
  filePath: string,
  version?: string | number,
): string {
  const collection = target.kind === 'worktree' ? 'worktrees' : 'sessions';
  const versionParam = version === undefined ? '' : `&v=${encodeURIComponent(String(version))}`;
  return `/api/${collection}/${encodeURIComponent(target.id)}/file?path=${encodeURIComponent(filePath)}&raw=1${versionParam}`;
}
