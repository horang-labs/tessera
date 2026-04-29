export interface WorktreeDiffStats {
  added: number;
  removed: number;
  changedFiles: number;
  newFiles: number;
  deletedFiles: number;
  computedAt: string;
}

export interface WorktreeFileDiffStats {
  added: number;
  removed: number;
}
