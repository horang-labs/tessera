'use client';

import { useState, useEffect, useMemo, memo, useCallback } from 'react';
import type { Highlighter } from 'shiki';
import { useI18n } from '@/lib/i18n';
import { useIsDark } from '@/hooks/use-is-dark';

interface CodeBlockProps {
  code: string;
  language: string;
  filename?: string;
}

// Singleton highlighter instance
let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter | null> | null = null;

async function getHighlighterInstance(): Promise<Highlighter | null> {
  if (highlighterInstance) {
    return highlighterInstance;
  }

  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const shiki = await import('shiki');
        const highlighter = await shiki.createHighlighter({
          themes: ['github-dark', 'github-light'],
          langs: [
            'javascript',
            'typescript',
            'python',
            'bash',
            'shell',
            'json',
            'markdown',
            'html',
            'css',
            'yaml',
            'sql',
            'rust',
            'go',
            'java',
            'cpp',
            'c',
            'tsx',
            'jsx',
          ],
        });
        highlighterInstance = highlighter;
        return highlighter;
      } catch {
        // Shiki dynamic import fails in custom server dev mode (webpack chunk issue)
        // Gracefully fallback to plain text rendering
        highlighterPromise = null;
        return null;
      }
    })();
  }

  return highlighterPromise;
}

export const CodeBlock = memo(function CodeBlock({ code, language, filename }: CodeBlockProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const isDark = useIsDark();

  useEffect(() => {
    getHighlighterInstance().then(h => {
      if (h) setHighlighter(h);
    });
  }, []);

  const shikiTheme = isDark ? 'github-dark' : 'github-light';

  const highlightedCode = useMemo(() => {
    if (!highlighter) return code;

    try {
      let normalizedLang = language.toLowerCase();
      if (normalizedLang === 'sh') normalizedLang = 'bash';
      if (normalizedLang === 'ts') normalizedLang = 'typescript';
      if (normalizedLang === 'js') normalizedLang = 'javascript';
      if (normalizedLang === 'py') normalizedLang = 'python';

      return highlighter.codeToHtml(code, {
        lang: normalizedLang || 'text',
        theme: shikiTheme,
      });
    } catch {
      try {
        return highlighter.codeToHtml(code, {
          lang: 'text',
          theme: shikiTheme,
        });
      } catch {
        return code;
      }
    }
  }, [highlighter, code, language, shikiTheme]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  }, [code]);

  const isHighlighted = highlighter && highlightedCode !== code;

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-(--divider) bg-(--tool-param-bg)">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--tool-bg) border-b border-(--divider)">
        <div className="flex items-center gap-2">
          {filename && (
            <span className="text-xs text-(--text-secondary)">{filename}</span>
          )}
          <span className="text-[10px] text-(--text-muted) uppercase">{language || 'text'}</span>
        </div>

        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] text-(--text-muted) hover:text-(--text-primary) hover:bg-(--sidebar-hover) rounded transition-colors"
        >
          {copied ? (
            <>
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span>{t('chat.copied')}</span>
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              <span>{t('chat.copy')}</span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <div className="overflow-x-auto">
        {isHighlighted ? (
          <div
            className="shiki-code-block"
            dangerouslySetInnerHTML={{ __html: highlightedCode }}
          />
        ) : (
          <pre className="px-3 py-3 text-[13px] text-(--text-secondary) font-mono leading-relaxed">
            <code className={`language-${language}`}>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
});
