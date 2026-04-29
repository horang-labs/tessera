'use client';

import { cn } from '@/lib/utils';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';
import { MessageRowShell } from './message-row-shell';

interface ChatAreaSkeletonProps {
  isSinglePanel?: boolean;
}

const MESSAGE_SKELETON_HEIGHTS = [76, 92, 64, 88, 72] as const;

export function ChatAreaSkeleton({ isSinglePanel = false }: ChatAreaSkeletonProps) {
  return (
    <div
      className={cn(
        'flex-1 flex flex-col py-6 space-y-4',
        isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-6'
      )}
      data-testid="chat-skeleton"
      aria-label="Loading messages..."
    >
      {/* 5개 메시지 플레이스홀더 */}
      {MESSAGE_SKELETON_HEIGHTS.map((height, i) => (
        <MessageRowShell key={i} className="flex gap-3 animate-pulse">
          {/* 아바타 스켈레톤 */}
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />

          {/* 메시지 내용 스켈레톤 */}
          <div className="flex-1 space-y-2">
            {/* 발신자 이름 */}
            <div className="h-4 w-24 animate-pulse rounded-md bg-muted" />

            {/* 메시지 텍스트 (높이 랜덤화로 자연스러움) */}
            <div
              className="w-full animate-pulse rounded bg-muted"
              style={{ height }}
            />
          </div>
        </MessageRowShell>
      ))}
    </div>
  );
}
