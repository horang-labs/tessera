import type { EnhancedMessage } from '@/types/chat';
import type { GroupedItem } from '@/lib/chat/group-messages';

export interface MessageSearchMatch {
  messageId: string;
  messageType: EnhancedMessage['type'];
  preview: string;
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase();
}

function stringifySearchValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getTextContentSearchText(content: Extract<EnhancedMessage, { type: 'text' }>['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if ('text' in block && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function getMessageSearchText(message: EnhancedMessage): string {
  switch (message.type) {
    case 'text':
      return getTextContentSearchText(message.content);
    case 'thinking':
      return message.content;
    case 'system':
      return message.message;
    case 'progress_hook':
      return message.errorMessage ?? '';
    case 'tool_call':
      return [
        message.toolName,
        stringifySearchValue(message.toolParams),
        message.output,
        message.error,
      ].filter(Boolean).join('\n');
    default:
      return '';
  }
}

export function findMessageSearchMatches(
  messages: EnhancedMessage[],
  rawQuery: string,
): MessageSearchMatch[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const normalizedQuery = normalizeSearchText(query);
  const matches: MessageSearchMatch[] = [];

  for (const message of messages) {
    const text = getMessageSearchText(message);
    if (!normalizeSearchText(text).includes(normalizedQuery)) continue;
    matches.push({
      messageId: message.id,
      messageType: message.type,
      preview: text.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }

  return matches;
}

function groupedItemContainsMessage(item: GroupedItem, messageId: string): boolean {
  if (item.kind === 'single') return item.message.id === messageId;
  return item.messages.some((message) => message.id === messageId);
}

export function findGroupedRowIndexForMessage(
  groupedMessages: GroupedItem[],
  messageId: string,
): number {
  return groupedMessages.findIndex((item) => groupedItemContainsMessage(item, messageId));
}
