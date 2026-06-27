'use client';

import { memo, useCallback, useState } from 'react';
import { Check, Copy, Languages, MessageSquarePlus } from 'lucide-react';
import type { AgentMessageGroup as AgentMessageGroupModel, AgentSubGroup, AssistantTextMessage } from '@/lib/chat/group-messages';
import type { TextMessage, ToolCallMessage } from '@/types/chat';
import type { AgentProgressData, McpProgressData } from '@/types/cli-jsonl-schemas';
import { Tooltip } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { wsClient } from '@/lib/ws/client';
import { ProviderLogoMark, getProviderBrand } from './provider-brand';
import { ThinkingBlock } from './thinking-block';
import { AgentProgress } from './progress/agent-progress';
import { McpProgress } from './progress/mcp-progress';
import { ToolCallGrid } from './tool-call-grid';
import { AssistantTextBody, extractAssistantText, type ForkFromMessageHandler } from './message-bubble-content';
import { MessageRowShell } from './message-row-shell';

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

interface AgentMessageGroupProps {
  group: AgentMessageGroupModel;
  providerId?: string;
  onSelectToolCall: (toolCall: ToolCallMessage | null) => void;
  selectedToolCallId: string | null;
  disableAnimation?: boolean;
  onForkFromMessage?: ForkFromMessageHandler;
}

interface AgentSubGroupViewProps {
  subgroup: AgentSubGroup;
  providerId?: string;
  onSelectToolCall: (toolCall: ToolCallMessage | null) => void;
  selectedToolCallId: string | null;
  disableAnimation?: boolean;
  onForkFromMessage?: ForkFromMessageHandler;
}

const MESSAGE_ACTIONS_CLASS =
  'ml-auto inline-flex shrink-0 items-center gap-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';

const MESSAGE_ACTION_BUTTON_CLASS =
  'inline-flex h-5 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-[10px] text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--accent)';

const MESSAGE_COPY_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} w-[4.75rem]`;
const MESSAGE_FORK_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} w-[6.25rem]`;

/**
 * Translate button for the subgroup header action row. Operates on EVERY assistant
 * text bubble in the subgroup (the intermediate ones before tool calls and the final
 * answer alike), so a single click translates the whole agent turn. Requests are
 * auto-deferred while the turn is still streaming (see wsClient.translateMessage).
 */
function SubgroupTranslateButton({
  messages,
}: {
  messages: TextMessage[];
}) {
  const { t } = useI18n();
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const overrides = useChatStore((state) => state.messageViewOverride);
  const setMessageViewOverride = useChatStore((state) => state.setMessageViewOverride);

  const hasAnyTranslation = messages.some(
    (m) => typeof m.translatedContent === 'string' && m.translatedContent.length > 0,
  );
  const isAnyPending = messages.some((m) => m.translationStatus === 'pending');
  // "Showing translation" if any already-translated bubble is currently in translation
  // view (assistant bubbles default to 'translation').
  const showingTranslation = messages.some((m) => {
    const hasTranslation = typeof m.translatedContent === 'string' && m.translatedContent.length > 0;
    return hasTranslation && (overrides.get(m.id) ?? 'translation') === 'translation';
  });

  const handleClick = useCallback(() => {
    const sid = activeSessionId ?? '';
    if (hasAnyTranslation) {
      const next = showingTranslation ? 'original' : 'translation';
      for (const m of messages) {
        setMessageViewOverride(m.id, next);
      }
      return;
    }
    // No translation yet → request one for every text bubble and reveal it on arrival.
    for (const m of messages) {
      setMessageViewOverride(m.id, 'translation');
      const already = typeof m.translatedContent === 'string' && m.translatedContent.length > 0;
      if (!already && sid) wsClient.translateMessage(sid, m.id);
    }
  }, [activeSessionId, hasAnyTranslation, showingTranslation, messages, setMessageViewOverride]);

  const label = isAnyPending
    ? t('chat.translating')
    : hasAnyTranslation
      ? (showingTranslation ? t('chat.showOriginal') : t('chat.showTranslation'))
      : t('chat.translate');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isAnyPending}
      data-testid="message-translate-btn"
      className={MESSAGE_FORK_BUTTON_CLASS}
      title={t('chat.translate')}
    >
      <Languages className="w-3 h-3" />
      <span>{label}</span>
    </button>
  );
}

function AgentSubGroupView({
  subgroup,
  providerId,
  onSelectToolCall,
  selectedToolCallId,
  disableAnimation,
  onForkFromMessage,
}: AgentSubGroupViewProps) {
  const { t } = useI18n();
  const providerBrand = getProviderBrand(providerId);
  const timestamp = subgroup.messages[0]?.timestamp ?? new Date().toISOString();
  const [copied, setCopied] = useState(false);

  const textMessages = subgroup.items
    .filter(
      (item): item is { kind: 'message'; message: AssistantTextMessage } =>
        item.kind === 'message' && item.message.type === 'text',
    )
    .map((item) => item.message);

  const combinedText = textMessages
    .map((message) => extractAssistantText(message.content))
    .filter(Boolean)
    .join('\n\n');

  const handleCopy = useCallback(async () => {
    if (!combinedText) return;
    try {
      await navigator.clipboard.writeText(combinedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [combinedText]);

  const forkTargetMessage = subgroup.messages[subgroup.messages.length - 1];

  return (
    <MessageRowShell
      data-testid="agent-message-group"
      className={`flex gap-3 px-2 py-1 group${disableAnimation ? '' : ' message-enter'}`}
    >
      <div className="shrink-0 pt-0.5">
        <ProviderLogoMark
          providerId={providerId}
          className="h-8 w-8 rounded-lg"
          iconClassName="h-4 w-4"
        />
      </div>

      <div className="flex-1 min-w-0">
        <div data-testid="agent-message-header" className="flex items-baseline gap-2 mb-0.5 max-w-2xl">
          <span
            className="text-sm font-medium"
            style={{ color: providerBrand.tone.icon }}
          >
            {providerBrand.label}
          </span>
          <Tooltip content={formatMessageFullTime(timestamp)}>
            <span className="text-[10px] text-(--text-muted) opacity-0 group-hover:opacity-100 transition-opacity cursor-default">
              {formatMessageTime(timestamp)}
            </span>
          </Tooltip>
          {combinedText && (
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
              <SubgroupTranslateButton messages={textMessages} />
              {onForkFromMessage && forkTargetMessage && (
                <button
                  type="button"
                  onClick={(event) => onForkFromMessage(forkTargetMessage, event.currentTarget)}
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

        <div className="max-w-2xl">
          {subgroup.items.map((item, index) => {
            if (item.kind === 'tool_call_group') {
              return (
                <ToolCallGrid
                  key={`tools-${item.messages[0]?.id ?? index}`}
                  toolCalls={item.messages}
                  onSelectToolCall={onSelectToolCall}
                  selectedToolCallId={selectedToolCallId}
                  alignWithMessageBody={false}
                />
              );
            }

            const message = item.message;
            if (message.type === 'thinking') {
              return (
                <ThinkingBlock
                  key={message.id}
                  {...message}
                  alignWithMessageBody={false}
                />
              );
            }

            if (message.type === 'text') {
              return (
                <AssistantTextBody
                  key={message.id}
                  message={message}
                />
              );
            }

            if (message.progressType === 'agent_progress') {
              return (
                <AgentProgress
                  key={message.id}
                  data={message.data as unknown as AgentProgressData}
                  alignWithMessageBody={false}
                />
              );
            }

            if (message.progressType === 'mcp_progress') {
              return (
                <McpProgress
                  key={message.id}
                  data={message.data as unknown as McpProgressData}
                  alignWithMessageBody={false}
                />
              );
            }

            return null;
          })}
        </div>
      </div>
    </MessageRowShell>
  );
}

export const AgentMessageGroup = memo(function AgentMessageGroup({
  group,
  providerId,
  onSelectToolCall,
  selectedToolCallId,
  disableAnimation,
  onForkFromMessage,
}: AgentMessageGroupProps) {
  return (
    <>
      {group.subgroups.map((subgroup, index) => (
        <AgentSubGroupView
          key={subgroup.messages[0]?.id ?? index}
          subgroup={subgroup}
          providerId={providerId}
          onSelectToolCall={onSelectToolCall}
          selectedToolCallId={selectedToolCallId}
          disableAnimation={disableAnimation}
          onForkFromMessage={onForkFromMessage}
        />
      ))}
    </>
  );
});
