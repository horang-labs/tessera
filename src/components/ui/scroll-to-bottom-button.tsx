'use client';

import { ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface ScrollToBottomButtonProps {
  onClick: () => void;
  title: string;
  className?: string;
  testId?: string;
}

export function ScrollToBottomButton({
  onClick,
  title,
  className,
  testId = 'scroll-to-bottom-button',
}: ScrollToBottomButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn(
        'absolute bottom-4 left-1/2 z-10 h-9 w-9 -translate-x-1/2 rounded-full border-(--divider) bg-(--chat-bg)/95 text-(--text-secondary) shadow-[0_10px_24px_rgba(0,0,0,0.14),0_1px_4px_rgba(0,0,0,0.10)] backdrop-blur transition-[background-color,color,opacity,transform] duration-200 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
        className,
      )}
      onClick={onClick}
      title={title}
      aria-label={title}
      data-testid={testId}
    >
      <ArrowDown className="h-4 w-4" />
    </Button>
  );
}
