export interface WorkspaceFileData {
  sessionId: string;
  workDir?: string | null;
  path: string;
  content: string;
  language: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}
