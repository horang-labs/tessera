'use client';

import type { ReactNode } from 'react';
import { CodeBlock } from './code-block';

interface MarkdownCodeProps {
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

interface RenderMarkdownCodeOptions {
  inlineClassName: string;
}

export function renderMarkdownCode(
  { className, children, ...props }: MarkdownCodeProps,
  { inlineClassName }: RenderMarkdownCodeOptions,
) {
  const match = /language-(\w+)/.exec(className || '');
  const isBlock = match || (typeof children === 'string' && children.includes('\n'));

  if (isBlock) {
    const language = match?.[1] || 'text';
    const code = String(children).replace(/\n$/, '');
    return <CodeBlock code={code} language={language} />;
  }

  return (
    <code className={inlineClassName} {...props}>
      {children}
    </code>
  );
}

export function renderMarkdownPre({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
