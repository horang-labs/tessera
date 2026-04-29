'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ShieldCheck, ShieldX, Shield, ChevronDown, ChevronRight } from 'lucide-react';
import { useWebSocket } from '@/hooks/use-websocket';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { getToolIcon, shortenToolName } from './tool-call-block';
import { useI18n } from '@/lib/i18n';

interface PermissionFloatingBarProps {
  toolName: string;
  toolInput: Record<string, any>;
  toolUseId: string;
  sessionId: string;
  decisionReason?: string;
  agentId?: string;
}

/** Extract a human-readable summary line from tool input */
function getInputSummary(toolName: string, input: Record<string, any>): string | null {
  const short = shortenToolName(toolName).toLowerCase();
  switch (short) {
    case 'bash':
    case 'shell':
      return input.command ? `$ ${input.command}` : null;
    case 'read':
    case 'write':
    case 'edit':
      return input.file_path || null;
    case 'glob':
      return input.pattern || null;
    case 'grep':
      return input.pattern ? `/${input.pattern}/` : null;
    case 'webfetch':
    case 'websearch':
      return input.url || input.query || null;
    default: {
      const firstVal = Object.values(input).find(v => typeof v === 'string');
      return typeof firstVal === 'string' ? firstVal.substring(0, 120) : null;
    }
  }
}

export function PermissionFloatingBar({
  toolName,
  toolInput,
  toolUseId,
  sessionId,
  decisionReason,
  agentId,
}: PermissionFloatingBarProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { sendInteractiveResponse } = useWebSocket();

  const displayName = shortenToolName(toolName);
  const inputSummary = getInputSummary(toolName, toolInput);

  const handleDecision = useCallback((choice: 'allow' | 'deny') => {
    const sent = sendInteractiveResponse(sessionId, toolUseId, choice);
    if (!sent) {
      // WebSocket not connected — keep the prompt visible so user can retry
      console.error('Permission response not sent: WebSocket disconnected');
      return;
    }
  }, [sendInteractiveResponse, sessionId, toolUseId]);

  // Auto-focus container on mount → keyboard immediately works
  // Only if this panel is the active panel (prevents stealing focus from other panels)
  useEffect(() => {
    const ps = usePanelStore.getState();
    const tabData = selectActiveTab(ps);
    const activePanelId = tabData?.activePanelId ?? '';
    const panels = tabData?.panels ?? {};
    if (panels[activePanelId]?.sessionId === sessionId) {
      requestAnimationFrame(() => containerRef.current?.focus());
    }
  }, [sessionId]);

  // Keyboard: Enter/Y = Allow, Esc/N = Deny
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      e.stopPropagation();
      handleDecision('allow');
    } else if (e.key === 'Escape' || e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      e.stopPropagation();
      handleDecision('deny');
    }
  }, [handleDecision]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      data-interactive-prompt
      className="rounded-lg border border-(--accent)/20 bg-(--accent)/5 shadow-lg overflow-hidden focus:outline-none"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-(--accent)/10">
        <Shield className="w-4 h-4 text-(--accent)" />
        <span className="text-sm font-medium text-(--accent)">
          {t('permission.required')}
        </span>
        {agentId && (
          <span className="text-[10px] text-(--text-muted) font-mono ml-1">
            {agentId}
          </span>
        )}
        <span className="text-xs text-(--text-muted) ml-auto">
          {t('permission.keyboardHint')}
        </span>
      </div>

      {/* Tool info */}
      <div className="p-4 space-y-2.5">
        {/* Tool name + icon */}
        <div className="flex items-center gap-2">
          <span className="text-(--accent)">{getToolIcon(toolName)}</span>
          <span className="font-mono text-sm font-medium text-(--text-primary)">
            {displayName}
          </span>
        </div>

        {/* Decision reason */}
        {decisionReason && (
          <p className="text-xs text-(--text-secondary)">{decisionReason}</p>
        )}

        {/* Input summary */}
        {inputSummary && (
          <div className="text-xs text-(--text-secondary) font-mono bg-(--tool-param-bg) px-2.5 py-1.5 rounded break-all">
            {inputSummary}
          </div>
        )}

        {/* Expandable full input */}
        {Object.keys(toolInput).length > 0 && (
          <>
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-xs text-(--text-muted) hover:text-(--text-secondary) transition-colors"
              tabIndex={-1}
            >
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {t('permission.showDetails')}
            </button>
            {expanded && (
              <pre className="text-xs overflow-x-auto max-h-[200px] overflow-y-auto bg-(--tool-param-bg) p-2.5 rounded font-mono text-(--text-secondary)">
                {JSON.stringify(toolInput, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>

      {/* Action bar */}
      <div className="px-4 py-2.5 border-t border-(--accent)/10 flex items-center justify-end gap-2">
        <button
          onClick={() => handleDecision('deny')}
          tabIndex={-1}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-(--error) text-white hover:opacity-90 transition-opacity"
        >
          <ShieldX className="w-3.5 h-3.5" />
          {t('permission.deny')}
          <kbd className="ml-1 text-[10px] opacity-70 font-mono">Esc</kbd>
        </button>
        <button
          onClick={() => handleDecision('allow')}
          tabIndex={-1}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-(--success) text-white hover:opacity-90 transition-opacity"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          {t('permission.allow')}
          <kbd className="ml-1 text-[10px] opacity-70 font-mono">↵</kbd>
        </button>
      </div>
    </div>
  );
}
