export interface WorkspaceFileData {
  sessionId: string;
  path: string;
  content: string;
  language: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}
