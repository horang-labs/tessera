'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ClipboardList, ChevronDown, ChevronRight, Check, X, FileText, Wrench } from 'lucide-react';
import { useWebSocket } from '@/hooks/use-websocket';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useI18n } from '@/lib/i18n';
import { PreviewMarkdown } from './preview-markdown';

interface PlanApprovalFloatingPanelProps {
  plan?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  planFilePath?: string;
  toolUseId: string;
  sessionId: string;
}

export function PlanApprovalFloatingPanel({
  plan,
  allowedPrompts,
  planFilePath,
  toolUseId,
  sessionId,
}: PlanApprovalFloatingPanelProps) {
  const { t } = useI18n();
  const [showTools, setShowTools] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { sendInteractiveResponse } = useWebSocket();

  const handleDecision = useCallback((choice: 'allow' | 'deny') => {
    const sent = sendInteractiveResponse(sessionId, toolUseId, choice);
    if (!sent) {
      console.error('Plan approval response not sent: WebSocket disconnected');
    }
  }, [sendInteractiveResponse, sessionId, toolUseId]);

  useEffect(() => {
    const ps = usePanelStore.getState();
    const tabData = selectActiveTab(ps);
    const activePanelId = tabData?.activePanelId ?? '';
    const panels = tabData?.panels ?? {};
    if (panels[activePanelId]?.sessionId === sessionId) {
      requestAnimationFrame(() => containerRef.current?.focus());
    }
  }, [sessionId]);

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
      className="rounded-lg border border-blue-500/20 bg-blue-500/5 shadow-lg overflow-hidden focus:outline-none"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-blue-500/10">
        <ClipboardList className="w-4 h-4 text-blue-500" />
        <span className="text-sm font-medium text-blue-500">
          {t('planApproval.title')}
        </span>
        <span className="text-xs text-(--text-muted) ml-auto">
          {t('planApproval.keyboardHint')}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {plan && (
          <div className="max-h-[300px] overflow-y-auto text-sm text-(--text-primary)">
            <PreviewMarkdown content={plan} />
          </div>
        )}

        {planFilePath && (
          <div className="flex items-center gap-1.5 text-xs text-(--text-muted)">
            <FileText className="w-3 h-3" />
            <span className="font-mono">{planFilePath}</span>
          </div>
        )}

        {allowedPrompts && allowedPrompts.length > 0 && (
          <div className="space-y-1.5">
            <button
              onClick={() => setShowTools(!showTools)}
              className="flex items-center gap-1 text-xs text-(--text-muted) hover:text-(--text-secondary) transition-colors"
              tabIndex={-1}
            >
              {showTools ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <Wrench className="w-3 h-3" />
              {t('planApproval.allowedTools', { count: allowedPrompts.length })}
            </button>
            {showTools && (
              <div className="flex flex-wrap gap-1.5 pl-4">
                {allowedPrompts.map((ap, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded-full bg-(--tool-param-bg) text-(--text-secondary)"
                    title={ap.prompt}
                  >
                    {ap.tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-blue-500/10 flex items-center justify-end gap-2">
        <button
          onClick={() => handleDecision('deny')}
          tabIndex={-1}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-(--error) text-white hover:opacity-90 transition-opacity"
        >
          <X className="w-3.5 h-3.5" />
          {t('planApproval.reject')}
          <kbd className="ml-1 text-[10px] opacity-70 font-mono">Esc</kbd>
        </button>
        <button
          onClick={() => handleDecision('allow')}
          tabIndex={-1}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:opacity-90 transition-opacity"
        >
          <Check className="w-3.5 h-3.5" />
          {t('planApproval.approve')}
          <kbd className="ml-1 text-[10px] opacity-70 font-mono">↵</kbd>
        </button>
      </div>
    </div>
  );
}
