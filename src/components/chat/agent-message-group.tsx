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
import { PHONE_TOUCH_TARGET_HEIGHT } from '@/lib/ui/touch-target';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

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

// Below the Phone viewport step these actions are simply present: `hover:` compiles to
// `@media (hover: hover)`, so on a phone no rule exists to reveal them. The reveal is kept
// from `sm` up, where a pointer is what drives the UI (#250).
// The `flex-wrap` and the missing `shrink-0` are #261; the reasoning lives with
// the twin of this constant in `message-bubble-content.tsx`. This is the variant
// the ticket was reported against.
const MESSAGE_ACTIONS_CLASS =
  'ml-auto inline-flex flex-wrap justify-end items-center gap-1 opacity-100 pointer-events-auto sm:opacity-0 sm:pointer-events-none transition-opacity sm:group-hover:opacity-100 sm:group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';

const MESSAGE_ACTION_BUTTON_CLASS =
  `inline-flex h-5 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-[10px] text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--accent) ${PHONE_TOUCH_TARGET_HEIGHT}`;

// Phones collapse to icon-only (see `.max-sm:sr-only` on the labels below);
// a fixed width would leave the icon stranded in a 76/100px pill. Desktop
// keeps the pill so the hover reveal does not reflow the header.
const MESSAGE_COPY_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} sm:w-[4.75rem] max-sm:aspect-square max-sm:px-0`;
const MESSAGE_FORK_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} sm:w-[6.25rem] max-sm:aspect-square max-sm:px-0`;

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
      {...telemetryClickAttributes('message.translate', 'message')}
      type="button"
      onClick={handleClick}
      disabled={isAnyPending}
      data-testid="message-translate-btn"
      className={MESSAGE_FORK_BUTTON_CLASS}
      title={t('chat.translate')}
    >
      <Languages className="w-3 h-3" />
      <span className="max-sm:sr-only">{label}</span>
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
      className={`flex gap-3 max-sm:gap-1.5 px-2 max-sm:px-1 py-1 group${disableAnimation ? '' : ' message-enter'}`}
    >
      <div className="shrink-0 pt-0.5">
        <ProviderLogoMark
          providerId={providerId}
          className="h-8 w-8 rounded-lg max-sm:h-4 max-sm:w-4 max-sm:rounded-md"
          iconClassName="h-4 w-4 max-sm:h-2.5 max-sm:w-2.5"
        />
      </div>

      <div className="flex-1 min-w-0">
        {/* `flex-wrap` so the actions row can take a line of its own — see
            MESSAGE_ACTIONS_CLASS above (#261). */}
        <div data-testid="agent-message-header" className="flex flex-wrap items-baseline gap-2 mb-0.5 max-w-2xl">
          <span
            className="text-sm font-medium"
            style={{ color: providerBrand.tone.icon }}
          >
            {providerBrand.label}
          </span>
          <Tooltip content={formatMessageFullTime(timestamp)}>
            <span className="text-[10px] text-(--text-muted) opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-default">
              {formatMessageTime(timestamp)}
            </span>
          </Tooltip>
          {combinedText && (
            <div data-testid="message-actions" className={MESSAGE_ACTIONS_CLASS}>
              <button
                {...telemetryClickAttributes('message.copy', 'message')}
                type="button"
                onClick={handleCopy}
                className={MESSAGE_COPY_BUTTON_CLASS}
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3" />
                    <span className="max-sm:sr-only">{t('chat.copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span className="max-sm:sr-only">{t('chat.copy')}</span>
                  </>
                )}
              </button>
              <SubgroupTranslateButton messages={textMessages} />
              {onForkFromMessage && forkTargetMessage && (
                <button
                  {...telemetryClickAttributes('message.fork', 'message')}
                  type="button"
                  onClick={(event) => onForkFromMessage(forkTargetMessage, event.currentTarget)}
                  className={MESSAGE_FORK_BUTTON_CLASS}
                  title={t('chat.forkFromHereTooltip')}
                >
                  <MessageSquarePlus className="w-3 h-3" />
                  <span className="max-sm:sr-only">{t('chat.forkFromHere')}</span>
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
