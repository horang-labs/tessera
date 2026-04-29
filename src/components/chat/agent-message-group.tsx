'use client';

import { memo, useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { AgentMessageGroup as AgentMessageGroupModel, AgentSubGroup } from '@/lib/chat/group-messages';
import type { ToolCallMessage } from '@/types/chat';
import type { AgentProgressData, McpProgressData } from '@/types/cli-jsonl-schemas';
import { Tooltip } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { ProviderLogoIcon, getProviderBrand } from './provider-brand';
import { ThinkingBlock } from './thinking-block';
import { AgentProgress } from './progress/agent-progress';
import { McpProgress } from './progress/mcp-progress';
import { ToolCallGrid } from './tool-call-grid';
import { AssistantTextBody, extractAssistantText } from './message-bubble-content';
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
}

interface AgentSubGroupViewProps {
  subgroup: AgentSubGroup;
  providerId?: string;
  onSelectToolCall: (toolCall: ToolCallMessage | null) => void;
  selectedToolCallId: string | null;
  disableAnimation?: boolean;
}

const MESSAGE_COPY_BUTTON_CLASS =
  'ml-auto inline-flex w-[4.75rem] shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] text-(--text-muted) opacity-0 pointer-events-none transition-[color,background-color,opacity] hover:bg-(--sidebar-hover) hover:text-(--text-primary) group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--accent)';

function AgentSubGroupView({
  subgroup,
  providerId,
  onSelectToolCall,
  selectedToolCallId,
  disableAnimation,
}: AgentSubGroupViewProps) {
  const { t } = useI18n();
  const providerBrand = getProviderBrand(providerId);
  const timestamp = subgroup.messages[0]?.timestamp ?? new Date().toISOString();
  const [copied, setCopied] = useState(false);

  const combinedText = subgroup.items
    .map((item) => {
      if (item.kind === 'message' && item.message.type === 'text') {
        return extractAssistantText(item.message.content);
      }
      return '';
    })
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

  return (
    <MessageRowShell
      data-testid="agent-message-group"
      className={`flex gap-3 px-2 py-1 group${disableAnimation ? '' : ' message-enter'}`}
    >
      <div className="shrink-0 pt-0.5">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: providerBrand.tone.avatarBg }}
        >
          <ProviderLogoIcon
            providerId={providerId}
            className="w-4 h-4"
            style={{ color: providerBrand.tone.avatarFg }}
          />
        </div>
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
            <button
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
        />
      ))}
    </>
  );
});
