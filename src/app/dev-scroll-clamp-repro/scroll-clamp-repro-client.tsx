'use client';

import { useMemo, useState } from 'react';
import { MessageList } from '@/components/chat/message-list';
import type { EnhancedMessage } from '@/types/chat';

const SESSION_ID = 'scroll-clamp-session';

function timestampFor(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
}

function assistantBody(index: number): string {
  return [
    `Assistant message ${index}`,
    'This paragraph exists to give the list enough height that the container actually overflows.',
    'Without a real scroll surface there is nothing for the browser to clamp, and the bug cannot appear.',
  ].join('\n\n');
}

/**
 * Reproduces the shrink that strands the list: a tool group renders as one row per
 * call up to three, then collapses into a single summary bar at four. Crossing that
 * boundary drops the group's height in one frame, so the browser clamps scrollTop
 * on a list that was pinned to the bottom — with no user input anywhere near it.
 */
function buildMessages(toolCount: number): EnhancedMessage[] {
  const messages: EnhancedMessage[] = [];

  for (let index = 0; index < 20; index += 1) {
    messages.push({
      id: `user-${index}`,
      type: 'text',
      role: 'user',
      content: `User prompt ${index}`,
      timestamp: timestampFor(index * 2),
    });
    messages.push({
      id: `assistant-${index}`,
      type: 'text',
      role: 'assistant',
      content: assistantBody(index),
      timestamp: timestampFor(index * 2 + 1),
    });
  }

  for (let index = 0; index < toolCount; index += 1) {
    messages.push({
      id: `tool-${index}`,
      type: 'tool_call',
      sessionId: SESSION_ID,
      toolName: 'Read',
      toolParams: { file_path: `/tmp/file-${index}.ts` },
      status: 'completed',
      timestamp: timestampFor(90 + index),
    });
  }

  return messages;
}

export function ScrollClampReproClient() {
  const [toolCount, setToolCount] = useState(3);
  // Stands in for the composer collapsing back to one row on send: the list gains
  // height while the messages stay byte-identical. Nothing in the content
  // signature moves, so the auto-scroll effect never fires and the only thing the
  // hook hears is the browser clamping scrollTop.
  const [reservedRows, setReservedRows] = useState(8);
  const messages = useMemo(() => buildMessages(toolCount), [toolCount]);

  return (
    <main className="flex h-screen flex-col bg-(--chat-bg) text-(--text-primary)">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-(--divider) px-4 text-xs text-(--text-secondary)">
        <span data-testid="tool-count">tools:{toolCount}</span>
        <span data-testid="reserved-rows">rows:{reservedRows}</span>
        <button
          type="button"
          className="rounded border border-(--divider) px-2 py-1 hover:bg-(--sidebar-hover)"
          data-testid="add-tool"
          onClick={() => setToolCount((current) => current + 1)}
        >
          Add tool call
        </button>
        <button
          type="button"
          className="rounded border border-(--divider) px-2 py-1 hover:bg-(--sidebar-hover)"
          data-testid="shrink-composer"
          onClick={() => setReservedRows(1)}
        >
          Shrink composer
        </button>
        <button
          type="button"
          className="rounded border border-(--divider) px-2 py-1 hover:bg-(--sidebar-hover)"
          data-testid="grow-composer"
          onClick={() => setReservedRows(8)}
        >
          Grow composer
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <MessageList
          messages={messages}
          isLoading={false}
          sessionId={SESSION_ID}
          hasMore={false}
          onLoadMore={() => undefined}
          isLoadingMore={false}
          isSinglePanel
          isTabActive
          isTurnInFlight
        />
      </div>

      <div
        className="shrink-0 border-t border-(--divider) bg-(--sidebar-hover) px-4 py-2 text-xs"
        style={{ height: `${reservedRows * 24 + 16}px` }}
        data-testid="fake-composer"
      >
        composer ({reservedRows} rows)
      </div>
    </main>
  );
}
