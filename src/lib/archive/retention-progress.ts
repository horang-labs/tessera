export interface ArchiveRetentionProgress {
  phase: 'idle' | 'scanning' | 'running' | 'waiting' | 'complete';
  total: number;
  completed: number;
  removed: number;
  skipped: number;
  errors: Array<{ id: string; kind: string; title?: string; error: string }>;
  currentTitle: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

