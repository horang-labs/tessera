'use client';

import { memo, useCallback, useState } from 'react';
import { Check, Copy, MessageSquarePlus } from 'lucide-react';
import type { AgentMessageGroup as AgentMessageGroupModel, AgentSubGroup } from '@/lib/chat/group-messages';
import type { TextMessage, ToolCallMessage } from '@/types/chat';
import type { AgentProgressData, McpProgressData } from '@/types/cli-jsonl-schemas';
import { Tooltip } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { ProviderLogoMark, getProviderBrand } from './provider-brand';
import { ThinkingBlock } from './thinking-block';
import { AgentProgress } from './progress/agent-progress';
import { McpProgress } from './progress/mcp-progress';
import { ToolCallGrid } from './tool-call-grid';
import { AssistantTextBody, MessageTranslateButton, extractAssistantText, type ForkFromMessageHandler } from './message-bubble-content';
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

const MESSAGE_ACTION_BUTTON_CLASS =
  'inline-flex h-5 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-[10px] text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--accent)';

const MESSAGE_COPY_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} w-[4.75rem]`;
const MESSAGE_FORK_BUTTON_CLASS = `${MESSAGE_ACTION_BUTTON_CLASS} w-[6.25rem]`;

/**
 * One assistant text bubble in a group, with its OWN hover action row
 * (Copy · Translate · From here). Per-bubble so every message — including the
 * intermediate ones before tool calls — is individually copyable/translatable/forkable.
 */
function GroupedAssistantText({
  message,
  onForkFromMessage,
}: {
  message: TextMessage;
  onForkFromMessage?: ForkFromMessageHandler;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(extractAssistantText(message.content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [message.content]);

  return (
    <div className="group/bubble relative">
      <div className="absolute right-0 -top-3 z-10 opacity-0 transition-opacity group-hover/bubble:opacity-100">
        <div className="inline-flex items-center gap-1 rounded-md bg-(--chat-bg) px-1 py-0.5 shadow-sm">
          <button type="button" onClick={handleCopy} className={MESSAGE_COPY_BUTTON_CLASS}>
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
          <MessageTranslateButton message={message} />
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
      <AssistantTextBody message={message} />
    </div>
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
                <GroupedAssistantText
                  key={message.id}
                  message={message}
                  onForkFromMessage={onForkFromMessage}
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
