export interface WorkspaceFileData {
  sessionId: string;
  workDir?: string | null;
  path: string;
  content: string;
  language: string;
  mimeType: string;
  size: number;
  /** Last-modified time the content was read at; the save-time optimistic lock. */
  mtimeMs: number;
  truncated: boolean;
  binary: boolean;
}
