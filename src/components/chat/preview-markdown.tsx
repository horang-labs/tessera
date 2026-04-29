'use client';

import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { renderMarkdownCode, renderMarkdownPre } from './markdown-code';

const PREVIEW_MARKDOWN_REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]];
type PreviewMarkdownCodeProps = ComponentProps<'code'> & { node?: unknown };

const PREVIEW_MARKDOWN_COMPONENTS: Components = {
  h1({ children }) {
    return (
      <h1 className="mb-2 mt-0 text-lg font-semibold leading-7 text-(--text-primary)">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mb-1.5 mt-3 text-base font-semibold leading-6 text-(--text-primary) first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mb-1 mt-2.5 text-sm font-medium leading-5 text-(--text-primary) first:mt-0">
        {children}
      </h3>
    );
  },
  h4({ children }) {
    return (
      <h4 className="mb-1 mt-2 text-xs font-semibold uppercase leading-5 text-(--text-muted) first:mt-0">
        {children}
      </h4>
    );
  },
  p({ children }) {
    return <p className="my-1.5 leading-6 text-(--text-secondary) first:mt-0 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return (
      <ul className="my-2 ml-4 list-disc space-y-1 text-(--text-secondary) marker:text-(--text-muted) first:mt-0 last:mb-0">
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="my-2 ml-4 list-decimal space-y-1 text-(--text-secondary) marker:text-(--text-muted) first:mt-0 last:mb-0">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return (
      <li className="pl-1 leading-6 text-(--text-secondary) [&>ol]:my-1 [&>p]:my-0 [&>ul]:my-1">
        {children}
      </li>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 rounded-r-md border-l-2 border-(--accent)/50 bg-(--accent)/5 py-1.5 pl-3 pr-2 text-(--text-secondary) [&>p]:my-0">
        {children}
      </blockquote>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-(--accent-light) underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  },
  strong({ children }) {
    return <strong className="font-semibold text-(--text-primary)">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic text-(--text-secondary)">{children}</em>;
  },
  del({ children }) {
    return <del className="text-(--text-muted) line-through decoration-(--text-muted)">{children}</del>;
  },
  hr() {
    return <hr className="my-3 border-(--divider)" />;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto rounded-md border border-(--divider) first:mt-0 last:mb-0">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-(--sidebar-hover)">{children}</thead>;
  },
  th({ children }) {
    return (
      <th className="border-b border-(--divider) px-2.5 py-1.5 text-left text-xs font-semibold text-(--text-primary)">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border-b border-(--divider) px-2.5 py-1.5 text-xs leading-5 text-(--text-secondary)">
        {children}
      </td>
    );
  },
  code({ className, children, ...props }: PreviewMarkdownCodeProps) {
    return renderMarkdownCode(
      { className, children, ...props },
      {
        inlineClassName: 'px-1.5 py-0.5 rounded text-[13px] font-mono bg-(--tool-param-bg) text-(--accent-light)',
      },
    );
  },
  pre({ children }) {
    return renderMarkdownPre({ children });
  },
};

interface PreviewMarkdownProps {
  content: string;
}

export function PreviewMarkdown({ content }: PreviewMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={PREVIEW_MARKDOWN_REMARK_PLUGINS}
      components={PREVIEW_MARKDOWN_COMPONENTS}
      skipHtml
    >
      {content}
    </ReactMarkdown>
  );
}
