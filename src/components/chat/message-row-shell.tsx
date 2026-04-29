import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MESSAGE_ROW_SHELL_CLASS } from './message-layout';

interface MessageRowShellProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function MessageRowShell({
  children,
  className,
  ...props
}: MessageRowShellProps) {
  return (
    <div className={cn(MESSAGE_ROW_SHELL_CLASS, className)} {...props}>
      {children}
    </div>
  );
}
