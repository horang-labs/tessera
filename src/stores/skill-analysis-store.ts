import { create } from 'zustand';
import type { SkillAnalysis } from '@/lib/skill/skill-analysis-types';

type AnalysisStatus = 'idle' | 'scanning' | 'analyzing' | 'completed' | 'failed';

interface SkillAnalysisState {
  status: AnalysisStatus;
  skillCount?: number;
  error?: string;
  result?: SkillAnalysis;
  startedAt?: string;
  model?: string;
  completedCount?: number;
  totalCount?: number;
  currentJobs?: string[];
  handleProgress: (msg: {
    status: AnalysisStatus;
    skillCount?: number;
    error?: string;
    result?: SkillAnalysis;
    startedAt?: string;
    model?: string;
    completedCount?: number;
    totalCount?: number;
    currentJobs?: string[];
  }) => void;
}

export const useSkillAnalysisStore = create<SkillAnalysisState>((set, get) => ({
  status: 'idle',
  handleProgress: (msg) =>
    set({
      status: msg.status,
      skillCount: msg.skillCount,
      error: msg.error,
      result: msg.result ?? get().result,
      startedAt: msg.startedAt,
      model: msg.model ?? get().model,
      completedCount: msg.completedCount,
      totalCount: msg.totalCount,
      currentJobs: msg.currentJobs,
    }),
}));
