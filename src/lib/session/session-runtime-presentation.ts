import type { UnifiedSession } from '@/types/chat';

export interface SessionRuntimePresentation {
  showRunning: boolean;
  canStop: boolean;
}

/** Runtime liveness powers the green status and explicit stop action. */
export function resolveSessionRuntimePresentation({
  isRunning,
}: Pick<UnifiedSession, 'kind' | 'isRunning'>): SessionRuntimePresentation {
  return {
    showRunning: isRunning,
    canStop: isRunning,
  };
}
