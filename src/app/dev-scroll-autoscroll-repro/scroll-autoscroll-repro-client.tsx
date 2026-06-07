'use client';

import { useEffect, useMemo, useState } from 'react';
import { MessageList } from '@/components/chat/message-list';
import type { EnhancedMessage } from '@/types/chat';

const SESSION_ID = 'scroll-repro-session';

function timestampFor(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
}

function assistantBody(index: number): string {
  return [
    `Assistant message ${index}`,
    'This paragraph is intentionally long enough to create a meaningful scroll surface for browser reproduction.',
    'It exercises the real markdown renderer, virtualizer measurement, and scroll anchoring path used by chat sessions.',
    'The content repeats across rows so the viewport can move away from the streaming tail and remain there.',
    'End of fixed block.',
  ].join('\n\n');
}

function streamingBody(streamTick: number): string {
  const chunks = Array.from({ length: streamTick + 1 }, (_, index) => (
    `stream chunk ${index}: growing assistant output below the reader viewport.`
  ));

  return [
    'Streaming assistant response',
    ...chunks,
  ].join('\n');
}

function buildMessages(streamTick: number): EnhancedMessage[] {
  const messages: EnhancedMessage[] = [];

  for (let index = 0; index < 28; index += 1) {
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

  messages.push({
    id: 'user-streaming-prompt',
    type: 'text',
    role: 'user',
    content: 'Start streaming now.',
    timestamp: timestampFor(98),
  });
  messages.push({
    id: 'assistant-streaming-tail',
    type: 'text',
    role: 'assistant',
    content: streamingBody(streamTick),
    timestamp: timestampFor(99),
  });

  return messages;
}

export function ScrollAutoscrollReproClient() {
  const [streamTick, setStreamTick] = useState(0);
  const [isStreaming, setIsStreaming] = useState(true);
  const messages = useMemo(() => buildMessages(streamTick), [streamTick]);

  useEffect(() => {
    if (!isStreaming) return;
    const intervalId = window.setInterval(() => {
      setStreamTick((current) => current + 1);
    }, 80);

    return () => window.clearInterval(intervalId);
  }, [isStreaming]);

  return (
    <main className="h-screen bg-(--chat-bg) text-(--text-primary)">
      <div className="flex h-12 items-center gap-3 border-b border-(--divider) px-4 text-xs text-(--text-secondary)">
        <span data-testid="stream-tick">tick:{streamTick}</span>
        <span data-testid="stream-state">{isStreaming ? 'streaming' : 'paused'}</span>
        <button
          type="button"
          className="rounded border border-(--divider) px-2 py-1 hover:bg-(--sidebar-hover)"
          data-testid="toggle-stream"
          onClick={() => setIsStreaming((current) => !current)}
        >
          Toggle
        </button>
      </div>
      <div className="h-[calc(100vh-3rem)]">
        <MessageList
          messages={messages}
          isLoading={false}
          sessionId={SESSION_ID}
          hasMore={false}
          onLoadMore={() => undefined}
          isLoadingMore={false}
          isSinglePanel
          isTabActive
          isTurnInFlight={isStreaming}
        />
      </div>
    </main>
  );
}
