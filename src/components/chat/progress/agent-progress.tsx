'use client';

import { memo } from 'react';
import { Bot, Loader2, Activity } from 'lucide-react';
import type { AgentProgressData } from '@/types/cli-jsonl-schemas';
import { cn } from '@/lib/utils';
import { MESSAGE_BODY_OFFSET_CLASS } from '../message-layout';
import { MessageRowShell } from '../message-row-shell';

interface AgentProgressProps {
  data: AgentProgressData;
  alignWithMessageBody?: boolean;
}

export const AgentProgress = memo(function AgentProgress({ data, alignWithMessageBody = true }: AgentProgressProps) {
  const { agentId, prompt, currentStep, totalSteps, progressPercent, phaseName } = data;
  const shortId = agentId?.slice(0, 7) || '?';
  const shortPrompt = prompt && prompt.length > 120 ? prompt.slice(0, 120) + '...' : prompt;

  // Calculate progress: use explicit progressPercent, or derive from steps
  const progress = progressPercent != null
    ? progressPercent
    : (currentStep != null && totalSteps != null && totalSteps > 0)
      ? Math.round((currentStep / totalSteps) * 100)
      : null;

  const content = (
    <div className={cn(
      'my-1 max-w-2xl rounded-lg overflow-hidden border border-(--accent)/30 bg-(--accent)/5',
      alignWithMessageBody && MESSAGE_BODY_OFFSET_CLASS,
    )}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Bot className="w-3.5 h-3.5 text-(--accent) shrink-0" />
        <span className="text-xs text-(--accent)">Agent</span>
        <span className="text-[10px] px-1 py-0.5 rounded bg-(--tool-param-bg) text-(--text-muted) font-mono">
          {shortId}
        </span>

        {/* Step progress */}
        {currentStep != null && totalSteps != null && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-(--text-muted)">
            <Activity className="w-2.5 h-2.5" />
            {currentStep}/{totalSteps}
          </span>
        )}

        {/* Phase name */}
        {phaseName && (
          <span className="text-[10px] text-(--accent)/80 italic truncate max-w-[150px]">
            {phaseName}
          </span>
        )}

        <Loader2 className="w-3 h-3 text-(--accent) animate-spin ml-auto shrink-0" />
      </div>

      {/* Progress bar */}
      {progress != null && (
        <div className="mx-3 mb-1.5">
          <div
            className="h-1 rounded-full bg-(--tool-param-bg) overflow-hidden"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-(--accent) transition-all duration-300 ease-out"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </div>
      )}

      {shortPrompt && (
        <div className="text-[11px] text-(--text-muted) mx-3 mb-2 px-2 py-1 bg-(--tool-param-bg) rounded italic truncate">
          {shortPrompt}
        </div>
      )}
    </div>
  );

  if (!alignWithMessageBody) return content;
  return <MessageRowShell>{content}</MessageRowShell>;
});
