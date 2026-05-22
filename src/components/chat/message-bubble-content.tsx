'use client';

import { memo, useState, useCallback, type ReactNode } from 'react';
import Image from 'next/image';
import type { Components } from 'react-markdown';
import { Copy, Check, MessageSquarePlus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { useI18n } from '@/lib/i18n';
import type { EnhancedMessage } from '@/types/chat';
import { ThinkingBlock } from './thinking-block';
import { SystemMessageBlock } from './system-message-block';
import { AgentProgress } from './progress/agent-progress';
import { McpProgress } from './progress/mcp-progress';
import type {
  AgentProgressData,
  McpProgressData,
} from '@/types/cli-jsonl-schemas';
import { Tooltip } from '@/components/ui/tooltip';
import type { ContentBlock } from '@/lib/ws/message-types';
import { useSettingsStore } from '@/stores/settings-store';
import {
  DEFAULT_PROFILE_AVATAR_DATA_URL,
  DEFAULT_PROFILE_DISPLAY_NAME,
} from '@/lib/settings/profile-defaults';
import { ImageLightbox } from './image-lightbox';
import { ProviderLogoMark, getProviderBrand } from './provider-brand';
import { renderMarkdownCode, renderMarkdownPre } from './markdown-code';
import { MessageRowShell } from './message-row-shell';

type TextMessage = Extract<EnhancedMessage, { type: 'text' }>;
export type ForkFromMessageHandler = (message: EnhancedMessage, anchorElement: HTMLElement) => void;

interface TimestampFormatterProps {
  formatTime: (timestamp: string) => string;
  formatFullTime: (timestamp: string) => string;
}

const MESSAGE_ACTIONS_CLASS =
  'ml-auto inline-flex shrink-0 items-center gap-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';

const MESSAGE_ACTION_BUTTON_CLASS =
  'inline-flex h-5 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-[10px] text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--accent)';

const MESSAGE_COPY_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} w-[4.75rem]`;
const MESSAGE_FORK_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} w-[6.25rem]`;

function formatMessageTime(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMessageFullTime(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export const extractAssistantText = extractTextContent;

const MARKDOWN_COMPONENTS: Components = {
  code({ className, children, ...props }) {
    return renderMarkdownCode(
      { className, children, ...props },
      {
        inlineClassName: 'px-1.5 py-0.5 rounded text-[13px] font-mono bg-(--code-inline-bg) text-(--accent)',
      },
    );
  },
  pre: renderMarkdownPre,
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-(--divider)">
        <table className="w-full text-sm border-collapse">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-(--sidebar-hover)">{children}</thead>;
  },
  th({ children }) {
    return (
      <th className="px-3 py-2 text-left font-semibold text-(--text-primary) border-b border-(--divider)">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="px-3 py-2 border-b border-(--divider) text-(--text-secondary)">
        {children}
      </td>
    );
  },
  p({ children }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return <ul className="ml-4 list-disc my-2 space-y-1 marker:text-(--text-muted)">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="ml-4 list-decimal my-2 space-y-1 marker:text-(--text-muted)">{children}</ol>;
  },
  li({ children }) {
    return <li className="pl-1 text-(--msg-assistant-text) [&>p]:mb-0">{children}</li>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-(--accent-light) hover:underline"
      >
        {children}
      </a>
    );
  },
  strong({ children }) {
    return <strong className="font-semibold text-(--text-primary)">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  del({ children }) {
    return (
      <del className="text-(--text-muted) line-through decoration-(--text-muted)">
        {children}
      </del>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-3 border-(--accent) pl-3 my-2 text-(--text-secondary) italic">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-3 border-(--divider)" />;
  },
  h1({ children }) {
    return <h1 className="text-2xl font-bold mt-5 mb-2 text-(--text-primary) leading-tight">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-xl font-bold mt-4 mb-2 text-(--text-primary) leading-tight">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-lg font-semibold mt-3 mb-1 text-(--text-primary) leading-snug">{children}</h3>;
  },
};

const REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]];

const MarkdownContent = memo(function MarkdownContent({
  content,
  isUser,
}: {
  content: string;
  isUser: boolean;
}) {
  if (!content) {
    return null;
  }

  if (isUser) {
    return (
      <>
        {content.split('\n').map((line, idx) => (
          <p key={idx} className={idx > 0 ? 'mt-1' : ''}>{line}</p>
        ))}
      </>
    );
  }

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
      skipHtml
    >
      {content}
    </ReactMarkdown>
  );
});

const ContentBlockRenderer = memo(function ContentBlockRenderer({
  blocks,
  isUser,
}: {
  blocks: ContentBlock[];
  isUser: boolean;
}) {
  const { t } = useI18n();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return (
              <MarkdownContent
                key={`text-${index}`}
                content={block.text}
                isUser={isUser}
              />
            );
          case 'image': {
            const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
            return (
              <button
                key={`img-${index}`}
                type="button"
                onClick={() => setLightboxSrc(dataUrl)}
                className="inline-block my-1 cursor-pointer rounded-lg overflow-hidden border border-(--divider) hover:border-(--accent) transition-colors"
              >
                <Image
                  src={dataUrl}
                  alt={t('validation.attachmentAlt', { id: index + 1 })}
                  width={200}
                  height={200}
                  unoptimized
                  sizes="200px"
                  className="max-w-[200px] max-h-[200px] object-contain"
                />
              </button>
            );
          }
          default:
            return null;
        }
      })}
      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          onClose={() => setLightboxSrc(null)}
        />
      )}
    </>
  );
});

function renderTextContent(content: string | ContentBlock[], isUser: boolean): ReactNode {
  if (typeof content === 'string') {
    return <MarkdownContent content={content} isUser={isUser} />;
  }

  return <ContentBlockRenderer blocks={content} isUser={isUser} />;
}

function getUserInitial(displayName: string): string {
  return Array.from(displayName.trim())[0]?.toUpperCase() || 'Y';
}

const UserAvatar = memo(function UserAvatar({
  avatarDataUrl,
  displayName,
}: {
  avatarDataUrl: string;
  displayName: string;
}) {
  return (
    <div className="w-8 h-8 rounded-lg bg-(--accent) flex items-center justify-center overflow-hidden shadow-sm text-xs font-semibold text-white">
      {avatarDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarDataUrl}
          alt={displayName}
          className="h-full w-full object-cover"
        />
      ) : (
        <span>{getUserInitial(displayName)}</span>
      )}
    </div>
  );
});

const UserMessage = memo(function UserMessage({
  message,
  formatTime,
  formatFullTime,
  onForkFromMessage,
}: {
  message: TextMessage;
  onForkFromMessage?: ForkFromMessageHandler;
} & TimestampFormatterProps) {
  const { t } = useI18n();
  const profile = useSettingsStore((state) => state.settings.profile);
  const [copied, setCopied] = useState(false);
  const displayName = profile.displayName.trim() || DEFAULT_PROFILE_DISPLAY_NAME;
  const avatarDataUrl = profile.avatarDataUrl.trim() || DEFAULT_PROFILE_AVATAR_DATA_URL;

  const getTextContent = useCallback(() => extractTextContent(message.content), [message.content]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getTextContent());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [getTextContent]);

  return (
    <MessageRowShell data-testid="user-message-row" className="flex gap-3 px-2 py-1 group">
      <div className="shrink-0 pt-0.5">
        <UserAvatar avatarDataUrl={avatarDataUrl} displayName={displayName} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1 max-w-2xl">
          <span className="text-sm font-medium text-(--accent)">{displayName}</span>
          <Tooltip content={formatFullTime(message.timestamp)}>
            <span className="text-[10px] text-(--text-muted) opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity cursor-default">
              {formatTime(message.timestamp)}
            </span>
          </Tooltip>
          <div className={MESSAGE_ACTIONS_CLASS}>
            <button
              type="button"
              onClick={handleCopy}
              className={MESSAGE_COPY_BUTTON_CLASS}
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3" />
                  <span>{t('chat.copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>{t('chat.copy')}</span>
                </>
              )}
            </button>
            {onForkFromMessage && (
              <button
                type="button"
                onClick={(event) => onForkFromMessage(message, event.currentTarget)}
                className={MESSAGE_FORK_BUTTON_CLASS}
                title={t('chat.forkFromHereTooltip')}
              >
                <MessageSquarePlus className="w-3 h-3" />
                <span>{t('chat.forkFromHere')}</span>
              </button>
            )}
          </div>
        </div>
        <div
          data-testid="user-message-bubble"
          className="w-fit max-w-full rounded-2xl rounded-tl-md bg-(--msg-user-bubble) border border-(--msg-user-bubble-border) px-3.5 py-2.5 shadow-sm sm:max-w-2xl"
        >
          <div className="text-sm text-(--msg-user-text) leading-relaxed break-words">
            {renderTextContent(message.content, true)}
          </div>
        </div>
      </div>
    </MessageRowShell>
  );
});

export const AssistantTextBody = memo(function AssistantTextBody({
  message,
}: {
  message: TextMessage;
}) {
  return (
    <div className="text-sm text-(--msg-assistant-text) leading-relaxed break-words">
      {renderTextContent(message.content, false)}
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  message,
  formatTime,
  formatFullTime,
  providerId,
  onForkFromMessage,
}: {
  message: TextMessage;
  providerId?: string;
  onForkFromMessage?: ForkFromMessageHandler;
} & TimestampFormatterProps) {
  const { t } = useI18n();
  const providerBrand = getProviderBrand(providerId);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(extractTextContent(message.content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [message.content]);

  return (
    <MessageRowShell className="flex gap-3 px-2 py-1 group">
      <div className="shrink-0 pt-0.5">
        <ProviderLogoMark
          providerId={providerId}
          className="h-8 w-8 rounded-lg"
          iconClassName="h-4 w-4"
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5 max-w-2xl">
          <span
            className="text-sm font-medium"
            style={{ color: providerBrand.tone.icon }}
          >
            {providerBrand.label}
          </span>
          <Tooltip content={formatFullTime(message.timestamp)}>
            <span className="text-[10px] text-(--text-muted) opacity-0 group-hover:opacity-100 transition-opacity cursor-default">
              {formatTime(message.timestamp)}
            </span>
          </Tooltip>
          {(message.content || onForkFromMessage) && (
            <div className={MESSAGE_ACTIONS_CLASS}>
              {message.content && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className={MESSAGE_COPY_BUTTON_CLASS}
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3" />
                      <span>{t('chat.copied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>{t('chat.copy')}</span>
                    </>
                  )}
                </button>
              )}
              {onForkFromMessage && (
                <button
                  type="button"
                  onClick={(event) => onForkFromMessage(message, event.currentTarget)}
                  className={MESSAGE_FORK_BUTTON_CLASS}
                  title={t('chat.forkFromHereTooltip')}
                >
                  <MessageSquarePlus className="w-3 h-3" />
                  <span>{t('chat.forkFromHere')}</span>
                </button>
              )}
            </div>
          )}
        </div>

        <AssistantTextBody message={message} />
      </div>
    </MessageRowShell>
  );
});

function renderTextMessage(
  message: TextMessage,
  providerId?: string,
  onForkFromMessage?: ForkFromMessageHandler,
): ReactNode {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    const textContent = typeof message.content === 'string' ? message.content : '';
    return (
      <MessageRowShell className="flex justify-center py-1">
        <span className="text-[11px] text-(--text-muted)">
          {textContent}
        </span>
      </MessageRowShell>
    );
  }

  const formatters: TimestampFormatterProps = {
    formatTime: formatMessageTime,
    formatFullTime: formatMessageFullTime,
  };

  if (isUser) {
    return (
      <UserMessage
        message={message}
        onForkFromMessage={onForkFromMessage}
        {...formatters}
      />
    );
  }

  return (
    <AssistantMessage
      message={message}
      providerId={providerId}
      onForkFromMessage={onForkFromMessage}
      {...formatters}
    />
  );
}

export function renderEnhancedContent(
  message: EnhancedMessage,
  providerId?: string,
  onForkFromMessage?: ForkFromMessageHandler,
): ReactNode {
  switch (message.type) {
    case 'text':
      return renderTextMessage(message, providerId, onForkFromMessage);
    case 'tool_call':
      return null;
    case 'thinking':
      return <ThinkingBlock {...message} />;
    case 'system':
      if (
        message.severity === 'info' &&
        message.subtype !== 'compact_boundary' &&
        message.subtype !== 'turn_duration'
      ) {
        return null;
      }
      return <SystemMessageBlock {...message} />;
    case 'progress_hook':
      if (message.progressType === 'agent_progress') {
        return <AgentProgress data={message.data as unknown as AgentProgressData} />;
      }
      if (message.progressType === 'mcp_progress') {
        return <McpProgress data={message.data as unknown as McpProgressData} />;
      }
      return null;
    default:
      const _exhaustive: never = message;
      return null;
  }
}
