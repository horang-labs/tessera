'use client';

import { memo, useState, useMemo, useCallback } from 'react';
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Wrench } from 'lucide-react';
import type { ToolCallMessage } from '@/types/chat';
import { useChatStore } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { getToolIcon, getToolSummary, shortenToolName } from './tool-call-block';
import { TOOL_STATUS_TEXT } from './tool-call-block-utils';
import { ToolCallDetailPanel } from './tool-call-detail-panel';
import { MESSAGE_BODY_OFFSET_CLASS } from './message-layout';
import { MessageRowShell } from './message-row-shell';

// --- Layout threshold ---
const SUMMARY_BAR_MIN = 4;

interface ToolCallGridProps {
  toolCalls: ToolCallMessage[];
  /** When provided, detail panel state is managed externally (e.g. VirtualizedMessageList). */
  onSelectToolCall?: (toolCall: ToolCallMessage | null) => void;
  selectedToolCallId?: string | null;
  alignWithMessageBody?: boolean;
}

// --- Prefetch helper ---

/** Extract toolUseId from message ID format: `${uuid}-tool-${toolUseId}` */
function extractToolUseId(toolCall: Pick<ToolCallMessage, 'id' | 'toolUseId'>): string | null {
  if (toolCall.toolUseId) return toolCall.toolUseId;

  const inlineMatch = toolCall.id.match(/-tool-(.+)$/);
  if (inlineMatch) return inlineMatch[1];

  const historyMatch = toolCall.id.match(/^hist-tool-(.+)$/);
  return historyMatch ? historyMatch[1] : null;
}

/** Check if a tool call needs output fetching (not cached, has output to load) */
function needsFetch(tc: ToolCallMessage): boolean {
  if (tc.status === 'running') return false;
  const toolUseId = extractToolUseId(tc);
  if (!toolUseId) return false;
  // Already cached
  if (useChatStore.getState().getToolOutput(toolUseId)) return false;
  // Has output that isn't loaded yet
  if (tc.hasOutput && tc.output == null && !tc.toolUseResult) return true;
  // Live session: has WS output but no structured result
  if (tc.output != null && !tc.toolUseResult) return true;
  return false;
}

/** Fetch tool output and store in cache. Returns true on success. */
async function prefetchToolOutput(tc: ToolCallMessage): Promise<boolean> {
  const toolUseId = extractToolUseId(tc);
  if (!toolUseId || !tc.sessionId) return false;

  const chatState = useChatStore.getState();
  if (chatState.getToolOutput(toolUseId)) return true; // Already cached

  const RETRY_DELAYS = [500, 1000, 2000];
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const params = new URLSearchParams({ toolUseId });
      const response = await fetch(`/api/sessions/${tc.sessionId}/tool-output?${params}`);

      if (response.status === 404 && attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      if (!response.ok) break;

      const data = await response.json();
      useChatStore.getState().setToolOutput(tc.sessionId, toolUseId, {
        output: data.output,
        toolUseResult: data.toolUseResult,
        isError: data.isError,
      });
      return true;
    } catch {
      if (attempt >= RETRY_DELAYS.length) break;
    }
  }

  // Cache failure so ToolCallBlock's auto-fetch skips (prevents duplicate retry cycle)
  useChatStore.getState().setToolOutput(tc.sessionId, toolUseId, {
    output: '',
    isError: false,
  });
  return false;
}

// --- Compact Row ---

function CompactRow({
  toolCall,
  isSelected,
  isLoading,
  onSelect,
}: {
  toolCall: ToolCallMessage;
  isSelected: boolean;
  isLoading: boolean;
  onSelect: () => void;
}) {
  const { toolName, toolParams, status, toolDisplay } = toolCall;
  const isError = status === 'error';
  const isRunning = status === 'running';

  const statusColor = isError
    ? TOOL_STATUS_TEXT.error
    : isRunning
      ? TOOL_STATUS_TEXT.running
      : TOOL_STATUS_TEXT.completed;

  const borderColor = isError
    ? 'border-red-900/40'
    : isSelected
      ? 'border-(--accent)/70'
      : isLoading
        ? 'border-(--accent)/40'
        : 'border-(--tool-border)';

  const bgColor = isSelected || isLoading
    ? 'bg-(--tool-header-hover)'
    : 'bg-(--tool-bg)';

  return (
    <button
      data-testid={`tool-call-row-${toolName}`}
      data-cell-id={toolCall.id}
      onClick={onSelect}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border ${borderColor} ${bgColor} hover:bg-(--tool-header-hover) transition-colors text-left w-full`}
    >
      <div className={`${statusColor} shrink-0`}>{getToolIcon(toolName, toolCall.toolKind)}</div>
      <span className="text-[11px] font-medium text-(--text-secondary) shrink-0 whitespace-nowrap max-w-[120px] truncate">
        {shortenToolName(toolName)}
      </span>
      <span className="text-[11px] text-(--text-muted) truncate font-mono flex-1 min-w-0">
        {getToolSummary(toolName, toolParams, toolCall.toolKind, toolDisplay) || '\u00A0'}
      </span>
      <div className="shrink-0">
        {isLoading && <Loader2 className="w-2.5 h-2.5 text-(--accent) animate-spin" />}
        {!isLoading && isRunning && <Loader2 className="w-2.5 h-2.5 text-(--accent) animate-spin" />}
        {!isLoading && status === 'completed' && <CheckCircle className={`w-2.5 h-2.5 ${TOOL_STATUS_TEXT.completed}`} />}
        {!isLoading && isError && <XCircle className={`w-2.5 h-2.5 ${TOOL_STATUS_TEXT.error}`} />}
      </div>
    </button>
  );
}

// --- Shared row list renderer ---

function RowList({
  toolCalls,
  selectedId,
  loadingId,
  onToggle,
}: {
  toolCalls: ToolCallMessage[];
  selectedId: string | null;
  loadingId: string | null;
  onToggle: (tc: ToolCallMessage) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {toolCalls.map(tc => (
        <CompactRow
          key={tc.id}
          toolCall={tc}
          isSelected={selectedId === tc.id}
          isLoading={loadingId === tc.id}
          onSelect={() => onToggle(tc)}
        />
      ))}
    </div>
  );
}

// --- Compact List (2~3 tools) ---

function CompactList({ toolCalls, selectedId, loadingId, onToggle, showInlinePanel, selectedToolCall, alignWithMessageBody }: {
  toolCalls: ToolCallMessage[];
  selectedId: string | null;
  loadingId: string | null;
  onToggle: (tc: ToolCallMessage) => void;
  showInlinePanel: boolean;
  selectedToolCall: ToolCallMessage | null;
  alignWithMessageBody: boolean;
}) {
  const content = (
    <div
      data-testid="tool-call-compact-list"
      className={cn('my-2 max-w-2xl', alignWithMessageBody && MESSAGE_BODY_OFFSET_CLASS)}
    >
      <RowList toolCalls={toolCalls} selectedId={selectedId} loadingId={loadingId} onToggle={onToggle} />
      {showInlinePanel && selectedToolCall && (
        <ToolCallDetailPanel
          toolCall={selectedToolCall}
          onClose={() => onToggle(selectedToolCall)}
        />
      )}
    </div>
  );

  if (!alignWithMessageBody) return content;
  return <MessageRowShell>{content}</MessageRowShell>;
}

// --- Summary Bar (4+ tools) ---

function getToolTypeCounts(toolCalls: ToolCallMessage[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tc of toolCalls) {
    const name = shortenToolName(tc.toolName);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function getStatusCounts(toolCalls: ToolCallMessage[]) {
  let completed = 0, error = 0, running = 0;
  for (const tc of toolCalls) {
    if (tc.status === 'completed') completed++;
    else if (tc.status === 'error') error++;
    else if (tc.status === 'running') running++;
  }
  return { completed, error, running };
}

function SummaryBar({ toolCalls, selectedId, loadingId, onToggle, showInlinePanel, selectedToolCall, alignWithMessageBody }: {
  toolCalls: ToolCallMessage[];
  selectedId: string | null;
  loadingId: string | null;
  onToggle: (tc: ToolCallMessage) => void;
  showInlinePanel: boolean;
  selectedToolCall: ToolCallMessage | null;
  alignWithMessageBody: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const typeCounts = useMemo(() => getToolTypeCounts(toolCalls), [toolCalls]);
  const statusCounts = useMemo(() => getStatusCounts(toolCalls), [toolCalls]);

  const typeSummary = typeCounts
    .slice(0, 4)
    .map(t => `${t.name} \u00D7${t.count}`)
    .join(', ');

  const content = (
    <div
      data-testid="tool-call-summary-bar"
      className={cn('my-2 max-w-2xl', alignWithMessageBody && MESSAGE_BODY_OFFSET_CLASS)}
    >
      <button
        onClick={() => setIsExpanded(prev => !prev)}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md border ${
          isExpanded ? 'border-(--accent)/50' : 'border-(--tool-border)'
        } bg-(--tool-bg) hover:bg-(--tool-header-hover) transition-colors text-left`}
      >
        <Wrench className="w-3.5 h-3.5 text-(--text-muted) shrink-0" />
        <span className="text-[11px] font-medium text-(--text-secondary)">
          {toolCalls.length} tool calls
        </span>
        <div className="flex items-center gap-2 text-[11px]">
          {statusCounts.completed > 0 && (
            <span className={`flex items-center gap-0.5 ${TOOL_STATUS_TEXT.completed}`}>
              <CheckCircle className="w-2.5 h-2.5" />{statusCounts.completed}
            </span>
          )}
          {statusCounts.error > 0 && (
            <span className={`flex items-center gap-0.5 ${TOOL_STATUS_TEXT.error}`}>
              <XCircle className="w-2.5 h-2.5" />{statusCounts.error}
            </span>
          )}
          {statusCounts.running > 0 && (
            <span className="flex items-center gap-0.5 text-(--accent)">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />{statusCounts.running}
            </span>
          )}
        </div>
        <span className="text-[11px] text-(--text-muted) truncate flex-1">
          {typeSummary}
        </span>
        <div className="shrink-0 text-(--text-muted)">
          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </div>
      </button>

      {isExpanded && (
        <div className="mt-1">
          <RowList toolCalls={toolCalls} selectedId={selectedId} loadingId={loadingId} onToggle={onToggle} />
        </div>
      )}

      {showInlinePanel && selectedToolCall && (
        <ToolCallDetailPanel
          toolCall={selectedToolCall}
          onClose={() => onToggle(selectedToolCall)}
        />
      )}
    </div>
  );

  if (!alignWithMessageBody) return content;
  return <MessageRowShell>{content}</MessageRowShell>;
}

// --- Adaptive Dispatcher ---

/**
 * Adaptive tool call layout:
 * - 2~3: Single-column compact list (icon + name + summary + status per row)
 * - 4+:  Collapsed summary bar → expands to same compact list
 *
 * Two modes:
 * - External state (onSelectToolCall provided): detail panel is rendered by parent
 *   (VirtualizedMessageList) as an overlay to avoid height-change flicker.
 * - Local state (onSelectToolCall not provided): detail panel is rendered inline
 *   (used in non-virtualized message-list.tsx where flicker is not an issue).
 *
 * Prefetch: On click, output is fetched BEFORE opening the detail panel so the
 * panel appears with full content (no layout shift from params-only → params+output).
 */
export const ToolCallGrid = memo(function ToolCallGrid({
  toolCalls,
  onSelectToolCall,
  selectedToolCallId,
  alignWithMessageBody = true,
}: ToolCallGridProps) {
  // Local fallback state when parent doesn't manage selection
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const isExternallyManaged = onSelectToolCall !== undefined;
  const effectiveSelectedId = isExternallyManaged ? (selectedToolCallId ?? null) : localSelectedId;

  const selectedToolCall = effectiveSelectedId
    ? toolCalls.find(tc => tc.id === effectiveSelectedId) ?? null
    : null;

  // Commit selection (after prefetch or immediately)
  const commitSelection = useCallback((tc: ToolCallMessage | null) => {
    if (isExternallyManaged) {
      onSelectToolCall(tc);
    } else {
      setLocalSelectedId(tc?.id ?? null);
    }
  }, [isExternallyManaged, onSelectToolCall]);

  const handleToggle = useCallback(async (tc: ToolCallMessage) => {
    // Toggle off: close immediately
    if (effectiveSelectedId === tc.id) {
      commitSelection(null);
      return;
    }

    // Check if fetch is needed
    if (!needsFetch(tc)) {
      // Already cached or no output to load — open immediately
      commitSelection(tc);
      return;
    }

    // Start loading: show spinner on the row, don't open panel yet
    setLoadingId(tc.id);
    const success = await prefetchToolOutput(tc);
    setLoadingId(null);

    // Open panel regardless of fetch result (fallback: show params only)
    if (success) {
      commitSelection(tc);
    } else {
      // Fetch failed — still open so user can see params + error
      commitSelection(tc);
    }
  }, [effectiveSelectedId, commitSelection]);

  // Show inline panel only when using local state (non-virtualized)
  const showInlinePanel = !isExternallyManaged;

  const commonProps = {
    toolCalls,
    selectedId: effectiveSelectedId,
    loadingId,
    onToggle: handleToggle,
    showInlinePanel,
    selectedToolCall,
    alignWithMessageBody,
  };

  if (toolCalls.length >= SUMMARY_BAR_MIN) {
    return <SummaryBar {...commonProps} />;
  }
  return <CompactList {...commonProps} />;
});
