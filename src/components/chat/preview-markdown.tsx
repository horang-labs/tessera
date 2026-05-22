'use client';

import type { ComponentProps } from 'react';
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { renderMarkdownCode, renderMarkdownPre } from './markdown-code';

const PREVIEW_MARKDOWN_REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]];
type PreviewMarkdownCodeProps = ComponentProps<'code'> & { node?: unknown };
type PreviewMarkdownImageProps = ComponentProps<'img'> & { node?: unknown };
type PreviewMarkdownTableCellProps = ComponentProps<'td'> & { node?: unknown; width?: number | string };
type PreviewMarkdownTableHeaderProps = ComponentProps<'th'> & { node?: unknown; width?: number | string };
type PreviewMarkdownVariant = 'compact' | 'document';

function mergeUnique<T>(...lists: Array<ReadonlyArray<T> | null | undefined>): T[] {
  return Array.from(new Set(lists.flatMap((list) => list ?? [])));
}

const PREVIEW_MARKDOWN_SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': mergeUnique(defaultSchema.attributes?.['*'], ['align', 'height', 'title', 'width']),
    img: mergeUnique(defaultSchema.attributes?.img, ['alt', 'height', 'src', 'title', 'width']),
    table: mergeUnique(defaultSchema.attributes?.table, ['align', 'width']),
    td: mergeUnique(defaultSchema.attributes?.td, ['align', 'colSpan', 'height', 'rowSpan', 'width']),
    th: mergeUnique(defaultSchema.attributes?.th, ['align', 'colSpan', 'height', 'rowSpan', 'width']),
  },
  protocols: {
    ...defaultSchema.protocols,
    src: mergeUnique(defaultSchema.protocols?.src, ['http', 'https', 'data']),
  },
  strip: mergeUnique(defaultSchema.strip, ['script', 'style']),
};

const PREVIEW_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, PREVIEW_MARKDOWN_SANITIZE_SCHEMA],
];

function normalizeTableCellWidth(width: number | string | undefined): string | undefined {
  if (typeof width === 'number') return `${width}px`;
  if (typeof width !== 'string') return undefined;

  const trimmedWidth = width.trim();
  return /^\d+(?:\.\d+)?(?:%|px|rem|em|ch|vw|vh)?$/.test(trimmedWidth) ? trimmedWidth : undefined;
}

const BASE_PREVIEW_MARKDOWN_COMPONENTS: Components = {
  h1({ children }) {
    return (
      <h1 className="mb-2 mt-0 text-xl font-semibold leading-7 text-(--text-primary)">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mb-1.5 mt-3 text-lg font-semibold leading-7 text-(--text-primary) first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mb-1 mt-2.5 text-base font-semibold leading-6 text-(--text-primary) first:mt-0">
        {children}
      </h3>
    );
  },
  h4({ children }) {
    return (
      <h4 className="mb-1 mt-2 text-sm font-semibold uppercase leading-5 text-(--text-muted) first:mt-0">
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
  th({ children, align, colSpan, rowSpan, width }: PreviewMarkdownTableHeaderProps) {
    const normalizedWidth = normalizeTableCellWidth(width);
    return (
      <th
        align={align}
        colSpan={colSpan}
        rowSpan={rowSpan}
        style={normalizedWidth ? { width: normalizedWidth } : undefined}
        className="border-b border-(--divider) px-2.5 py-1.5 text-left text-xs font-semibold text-(--text-primary)"
      >
        {children}
      </th>
    );
  },
  td({ children, align, colSpan, rowSpan, width }: PreviewMarkdownTableCellProps) {
    const normalizedWidth = normalizeTableCellWidth(width);
    return (
      <td
        align={align}
        colSpan={colSpan}
        rowSpan={rowSpan}
        style={normalizedWidth ? { width: normalizedWidth } : undefined}
        className="border-b border-(--divider) px-2.5 py-1.5 text-xs leading-5 text-(--text-secondary)"
      >
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

const DOCUMENT_PREVIEW_MARKDOWN_COMPONENTS: Components = {
  ...BASE_PREVIEW_MARKDOWN_COMPONENTS,
  h1({ children }) {
    return (
      <h1 className="mb-5 mt-10 border-b border-(--divider) pb-3 text-4xl font-bold leading-[1.15] text-(--text-primary) first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mb-3 mt-9 border-b border-(--divider) pb-2 text-2xl font-bold leading-tight text-(--text-primary) first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mb-2 mt-6 text-xl font-semibold leading-7 text-(--text-primary) first:mt-0">
        {children}
      </h3>
    );
  },
  h4({ children }) {
    return (
      <h4 className="mb-2 mt-5 text-lg font-semibold leading-7 text-(--text-primary) first:mt-0">
        {children}
      </h4>
    );
  },
  p({ children }) {
    return <p className="my-3 text-base leading-7 text-(--text-secondary) first:mt-0 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return (
      <ul className="my-3 ml-5 list-disc space-y-1.5 text-base leading-7 text-(--text-secondary) marker:text-(--text-muted) first:mt-0 last:mb-0">
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="my-3 ml-5 list-decimal space-y-1.5 text-base leading-7 text-(--text-secondary) marker:text-(--text-muted) first:mt-0 last:mb-0">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return (
      <li className="pl-1 leading-7 text-(--text-secondary) [&>ol]:my-1.5 [&>p]:my-1 [&>ul]:my-1.5">
        {children}
      </li>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-4 rounded-r-md border-l-3 border-(--accent)/60 bg-(--accent)/5 py-2 pl-4 pr-3 text-base leading-7 text-(--text-secondary) [&>p]:my-0">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-8 border-(--divider)" />;
  },
  table({ children }) {
    return (
      <div className="my-5 overflow-x-auto rounded-md border border-(--divider) first:mt-0 last:mb-0">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th({ children, align, colSpan, rowSpan, width }: PreviewMarkdownTableHeaderProps) {
    const normalizedWidth = normalizeTableCellWidth(width);
    return (
      <th
        align={align}
        colSpan={colSpan}
        rowSpan={rowSpan}
        style={normalizedWidth ? { width: normalizedWidth } : undefined}
        className="border-b border-(--divider) px-3 py-2 text-left text-sm font-semibold text-(--text-primary)"
      >
        {children}
      </th>
    );
  },
  td({ children, align, colSpan, rowSpan, width }: PreviewMarkdownTableCellProps) {
    const normalizedWidth = normalizeTableCellWidth(width);
    return (
      <td
        align={align}
        colSpan={colSpan}
        rowSpan={rowSpan}
        style={normalizedWidth ? { width: normalizedWidth } : undefined}
        className="border-b border-(--divider) px-3 py-2 text-sm leading-6 text-(--text-secondary)"
      >
        {children}
      </td>
    );
  },
  code({ className, children, ...props }: PreviewMarkdownCodeProps) {
    return renderMarkdownCode(
      { className, children, ...props },
      {
        inlineClassName: 'rounded bg-(--tool-param-bg) px-1.5 py-0.5 font-mono text-[0.95em] text-(--accent-light)',
      },
    );
  },
};

interface PreviewMarkdownProps {
  content: string;
  resolveImageSrc?: (src: string) => string | null;
  variant?: PreviewMarkdownVariant;
}

function createPreviewMarkdownComponents(
  resolveImageSrc?: (src: string) => string | null,
  variant: PreviewMarkdownVariant = 'compact',
): Components {
  const baseComponents = variant === 'document'
    ? DOCUMENT_PREVIEW_MARKDOWN_COMPONENTS
    : BASE_PREVIEW_MARKDOWN_COMPONENTS;

  return {
    ...baseComponents,
    img({ src, alt, title }: PreviewMarkdownImageProps) {
      const rawSrc = typeof src === 'string' ? src : '';
      const resolvedSrc = rawSrc && resolveImageSrc ? resolveImageSrc(rawSrc) : rawSrc;
      if (!resolvedSrc) return null;
      const imageClassName = variant === 'document'
        ? 'my-5 max-h-[36rem] max-w-full rounded-md border border-(--divider) object-contain first:mt-0 last:mb-0'
        : 'my-3 max-h-[32rem] max-w-full rounded-md border border-(--divider) object-contain first:mt-0 last:mb-0';

      return (
        <img
          src={resolvedSrc}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          className={imageClassName}
        />
      );
    },
  };
}

export function PreviewMarkdown({ content, resolveImageSrc, variant = 'compact' }: PreviewMarkdownProps) {
  const components = useMemo(
    () => createPreviewMarkdownComponents(resolveImageSrc, variant),
    [resolveImageSrc, variant],
  );

  return (
    <ReactMarkdown
      remarkPlugins={PREVIEW_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={PREVIEW_MARKDOWN_REHYPE_PLUGINS}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
