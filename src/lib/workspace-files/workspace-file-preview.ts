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

const WORKSPACE_VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
};

function extensionOf(filePath: string): string {
  const slashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dotIndex = filePath.lastIndexOf('.');
  return dotIndex > slashIndex ? filePath.slice(dotIndex + 1).toLowerCase() : '';
}

export function inferWorkspaceFileContentType(filePath: string): string {
  const extension = extensionOf(filePath);
  return WORKSPACE_IMAGE_MIME_BY_EXTENSION[extension]
    ?? WORKSPACE_VIDEO_MIME_BY_EXTENSION[extension]
    ?? 'application/octet-stream';
}

export function isWorkspaceImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

export function isWorkspaceVideoMimeType(mimeType: string | null | undefined): boolean {
  return mimeType === 'video/mp4';
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
