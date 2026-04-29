'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import type { ToolCallMessage } from '@/types/chat';
import { ToolCallBlock, getToolIcon, shortenToolName } from './tool-call-block';

interface ToolCallDetailPanelProps {
  toolCall: ToolCallMessage;
  onClose: () => void;
}

/**
 * Detail panel that renders as inline panel (desktop) or bottom sheet (mobile).
 * Reuses ToolCallBlock for the actual tool output rendering.
 */
export function ToolCallDetailPanel({ toolCall, onClose }: ToolCallDetailPanelProps) {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined'
      ? true
      : window.matchMedia('(min-width: 768px)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (isDesktop) {
    return <InlinePanel toolCall={toolCall} onClose={onClose} />;
  }

  return <BottomSheetPanel toolCall={toolCall} onClose={onClose} />;
}

// --- Shared detail content ---

function DetailContent({ toolCall }: { toolCall: ToolCallMessage }) {
  return (
    <ToolCallBlock
      key={toolCall.id}
      id={toolCall.id}
      type="tool_call"
      sessionId={toolCall.sessionId}
      toolName={toolCall.toolName}
      toolParams={toolCall.toolParams}
      toolDisplay={toolCall.toolDisplay}
      status={toolCall.status}
      output={toolCall.output}
      error={toolCall.error}
      toolUseResult={toolCall.toolUseResult}
      hasOutput={toolCall.hasOutput}
      defaultExpanded={true}
      inGrid={true}
    />
  );
}

// --- Desktop Inline Panel ---

function InlinePanel({ toolCall, onClose }: ToolCallDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      data-testid="tool-detail-panel"
      className="border-t-2 border-t-(--accent) bg-(--tool-bg) shadow-[0_-4px_20px_rgba(0,0,0,0.3)] max-h-[400px] flex flex-col"
    >
      <DetailHeader toolCall={toolCall} onClose={onClose} />
      <div className="p-3 overflow-y-auto flex-1">
        <DetailContent toolCall={toolCall} />
      </div>
    </div>
  );
}

// --- Mobile Bottom Sheet ---

function BottomSheetPanel({ toolCall, onClose }: ToolCallDetailPanelProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentY = useRef(0);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    currentY.current = e.touches[0].clientY;
    const diff = currentY.current - startY.current;
    if (diff > 0 && sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${diff}px)`;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    const diff = currentY.current - startY.current;
    if (diff > 100) {
      onClose();
    } else if (sheetRef.current) {
      sheetRef.current.style.transform = 'translateY(0)';
    }
    startY.current = 0;
    currentY.current = 0;
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div
      data-testid="tool-detail-sheet-backdrop"
      className="fixed inset-0 z-50 bg-black/50 flex items-end"
      onClick={handleBackdropClick}
    >
      <div
        ref={sheetRef}
        data-testid="tool-detail-sheet"
        className="w-full max-h-[70vh] bg-(--tool-bg) border-t border-(--tool-border) rounded-t-2xl flex flex-col"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="flex justify-center py-2">
          <div className="w-10 h-1 rounded-full bg-(--text-muted) opacity-40" />
        </div>
        <DetailHeader toolCall={toolCall} onClose={onClose} />
        <div className="p-3 overflow-y-auto flex-1">
          <DetailContent toolCall={toolCall} />
        </div>
      </div>
    </div>
  );
}

// --- Shared Header ---

function DetailHeader({ toolCall, onClose }: { toolCall: ToolCallMessage; onClose: () => void }) {
  return (
    <div className="px-3 py-2.5 bg-(--tool-header-hover) border-b border-(--tool-border) flex items-center gap-2">
      <div className="text-(--accent)">{getToolIcon(toolCall.toolName, toolCall.toolKind)}</div>
      <span className="text-sm font-medium text-(--text-secondary)">
        {shortenToolName(toolCall.toolName)}
      </span>
      <span className="text-xs text-(--text-muted) flex-1 truncate ml-1">
        Tool Output
      </span>
      <button
        onClick={onClose}
        className="shrink-0 p-1.5 rounded hover:bg-(--tool-bg) transition-colors text-(--text-muted) hover:text-(--text-secondary)"
        aria-label="Close detail panel"
        data-testid="tool-detail-close"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
