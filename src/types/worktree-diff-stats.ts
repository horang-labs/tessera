export interface WorktreeDiffStats {
  added: number;
  /**
   * True when `added` is only a lower bound because one or more untracked
   * files were deliberately not opened for line counting.
   */
  addedLinesIncomplete?: boolean;
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
