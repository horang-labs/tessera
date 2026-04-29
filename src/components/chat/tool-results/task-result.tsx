'use client';

import { useState, memo } from 'react';
import { ChevronRight, ChevronDown, CheckCircle, XCircle, Ban, Bot, Clock, Zap, Wrench, Rocket, FileText } from 'lucide-react';
import type {
  SubagentTaskCompletedResult,
  SubagentTaskStartedResult,
  SubagentTaskToolResult,
} from '@/types/tool-result';
import { cn } from '@/lib/utils';

/** Map subagent_type to display label and color */
function getAgentBadge(type: string): { label: string; color: string; bg: string } {
  switch (type) {
    case 'general-purpose': return { label: 'General', color: 'text-(--status-info-text)', bg: 'bg-(--status-info-bg)' };
    case 'Bash': return { label: 'Bash', color: 'text-(--status-success-text)', bg: 'bg-(--status-success-bg)' };
    case 'Explore': return { label: 'Explore', color: 'text-(--accent)', bg: 'bg-(--accent)/10' };
    case 'Plan': return { label: 'Plan', color: 'text-(--accent-light)', bg: 'bg-(--accent)/10' };
    default: return { label: type.length > 20 ? type.slice(0, 20) + '...' : type, color: 'text-(--text-muted)', bg: 'bg-(--sidebar-hover)' };
  }
}

interface TaskResultProps {
  result: SubagentTaskToolResult;
}

export const TaskResult = memo(function TaskResult({ result }: TaskResultProps) {
  const [isResponseExpanded, setIsResponseExpanded] = useState(false);

  if (!result || typeof result !== 'object') return null;

  if (result.phase === 'started') {
    const startedResult = result as SubagentTaskStartedResult;
    const badge = getAgentBadge(startedResult.agentType);
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded', badge.bg, badge.color)}>
            <Bot className="w-2.5 h-2.5" />
            {badge.label}
          </span>
          {startedResult.model && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-(--tool-param-bg) text-(--text-muted)">
              {startedResult.model}
            </span>
          )}
          {startedResult.runInBackground && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-(--status-warning-bg) text-(--status-warning-text)">
              background
            </span>
          )}
        </div>
        {startedResult.description && (
          <div className="text-[11px] text-(--text-secondary)">{startedResult.description}</div>
        )}
        {startedResult.prompt && (
          <div>
            <button
              onClick={(e) => { e.stopPropagation(); setIsResponseExpanded(v => !v); }}
              className="flex items-center gap-1 text-[11px] text-(--accent) hover:text-(--accent-light) transition-colors"
            >
              {isResponseExpanded
                ? <ChevronDown className="w-3 h-3" />
                : <ChevronRight className="w-3 h-3" />
              }
              Prompt
            </button>
            {isResponseExpanded && (
              <pre className="mt-1 text-[11px] text-(--text-secondary) bg-(--tool-output-bg) px-2.5 py-2 rounded overflow-x-auto font-mono whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                {startedResult.prompt}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  if (result.phase === 'async_started') {
    const { agentId, description, outputFile } = result;
    const shortId = agentId?.slice(0, 7) || '?';

    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded', 'bg-(--status-info-bg)', 'text-(--status-info-text)')}>
            <Rocket className="w-2.5 h-2.5" />
            Async
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-(--tool-param-bg) text-(--text-muted)">
            <Bot className="w-2.5 h-2.5" />
            {shortId}
          </span>
        </div>
        {description && (
          <div className="text-[11px] text-(--text-secondary)">{description}</div>
        )}
        {outputFile && (
          <div className="flex items-center gap-1 text-[10px] text-(--text-muted)">
            <FileText className="w-2.5 h-2.5" />
            <span className="font-mono truncate">{outputFile}</span>
          </div>
        )}
      </div>
    );
  }

  const completedResult = result as SubagentTaskCompletedResult;
  const { status, agentId, responseText } = completedResult;
  const shortId = agentId?.slice(0, 7) || '?';
  const durationSec = (completedResult.metrics.totalDurationMs / 1000).toFixed(1);
  const costUsd = completedResult.metrics.costUsd;

  const statusConfig = {
    completed: { icon: CheckCircle, color: 'text-(--status-success-text)', bg: 'bg-(--status-success-bg)', label: 'Completed' },
    failed: { icon: XCircle, color: 'text-(--status-error-text)', bg: 'bg-(--status-error-bg)', label: 'Failed' },
    cancelled: { icon: Ban, color: 'text-gray-400', bg: 'bg-gray-900/30', label: 'Cancelled' },
  }[status] || { icon: CheckCircle, color: 'text-gray-400', bg: 'bg-gray-900/30', label: status };

  const StatusIcon = statusConfig.icon;

  return (
    <div className="space-y-1.5">
      {/* Header: status + agent ID */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded', statusConfig.bg, statusConfig.color)}>
          <StatusIcon className="w-2.5 h-2.5" />
          {statusConfig.label}
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-(--tool-param-bg) text-(--text-muted)">
          <Bot className="w-2.5 h-2.5" />
          {shortId}
        </span>
      </div>

      {/* Stats - only show if we have the data */}
      {(completedResult.metrics.totalDurationMs != null || completedResult.metrics.totalTokens != null) && (
        <div className="flex items-center gap-3 text-[10px] text-(--text-muted)">
          {completedResult.metrics.totalDurationMs != null && (
            <span className="inline-flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {durationSec}s
            </span>
          )}
          {completedResult.metrics.totalTokens != null && (
            <span className="inline-flex items-center gap-1">
              <Zap className="w-2.5 h-2.5" />
              {completedResult.metrics.totalTokens.toLocaleString()} tokens
            </span>
          )}
          {completedResult.metrics.totalToolUseCount != null && (
            <span className="inline-flex items-center gap-1">
              <Wrench className="w-2.5 h-2.5" />
              {completedResult.metrics.totalToolUseCount} tool calls
            </span>
          )}
          {costUsd != null && (
            <span>${costUsd.toFixed(4)}</span>
          )}
        </div>
      )}

      {/* Response text (collapsible) */}
      {responseText && (
        <div>
          <button
            onClick={(e) => { e.stopPropagation(); setIsResponseExpanded(v => !v); }}
            className="flex items-center gap-1 text-[11px] text-(--accent) hover:text-(--accent-light) transition-colors"
          >
            {isResponseExpanded
              ? <ChevronDown className="w-3 h-3" />
              : <ChevronRight className="w-3 h-3" />
            }
            Agent response
          </button>
          {isResponseExpanded && (
            <pre className="mt-1 text-[11px] text-(--text-secondary) bg-(--tool-output-bg) px-2.5 py-2 rounded overflow-x-auto font-mono whitespace-pre-wrap max-h-[300px] overflow-y-auto">
              {responseText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
