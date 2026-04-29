import type { EnhancedMessage, ProgressHookMessage, TextMessage, ThinkingMessage, ToolCallMessage } from '@/types/chat';
import { isRenderableEnhancedMessage } from './renderability';

/**
 * A group of consecutive tool_call messages (1 or more)
 */
export interface ToolCallGroup {
  kind: 'tool_call_group';
  messages: ToolCallMessage[];
}

export type AgentBlockMessage =
  | ToolCallMessage
  | ThinkingMessage
  | ProgressHookMessage
  | AssistantTextMessage;

export type AssistantTextMessage = TextMessage & { role: 'assistant' };

export type AgentBlockGroupItem =
  | ToolCallGroup
  | {
      kind: 'message';
      message: ThinkingMessage | ProgressHookMessage | AssistantTextMessage;
    };

/**
 * A contiguous run of agent blocks rendered under a single chrome header.
 * A new subgroup is started when an assistant text block arrives and the
 * previous subgroup has accumulated 5+ non-text blocks (thinking/tool_call/
 * progress) — this visually separates "a lot of work" from its summary text.
 */
export interface AgentSubGroup {
  items: AgentBlockGroupItem[];
  messages: AgentBlockMessage[];
}

/**
 * A single assistant-owned visual group containing one or more subgroups.
 * Each subgroup renders its own chrome (provider icon + label).
 */
export interface AgentMessageGroup {
  kind: 'agent_message_group';
  subgroups: AgentSubGroup[];
  messages: AgentBlockMessage[];
}

/**
 * A single message that renders outside agent block chrome.
 */
export interface SingleMessage {
  kind: 'single';
  message: EnhancedMessage;
}

/**
 * Grouped item for rendering.
 */
export type GroupedItem = ToolCallGroup | AgentMessageGroup | SingleMessage;

/** Threshold: when streaming assistant text and the current subgroup already
 *  has this many non-text blocks, start a fresh subgroup (with its own header)
 *  so the summary text is visually separated from the preceding work. */
const SUBGROUP_TEXT_BREAK_THRESHOLD = 5;

function isToolCallMessage(message: EnhancedMessage): message is ToolCallMessage {
  return message.type === 'tool_call';
}

function isAssistantTextMessage(message: EnhancedMessage): message is AssistantTextMessage {
  return message.type === 'text' && message.role === 'assistant';
}

function isAgentBlockMessage(message: EnhancedMessage): message is AgentBlockMessage {
  if (isToolCallMessage(message)) return true;
  if (message.type === 'thinking') return true;
  if (message.type === 'progress_hook') return isRenderableEnhancedMessage(message);
  return isAssistantTextMessage(message);
}

/**
 * Groups consecutive assistant-owned block messages into AgentMessageGroup items.
 *
 * Algorithm:
 * - Consecutive thinking / progress / tool_call / assistant-text messages form a
 *   single AgentMessageGroup.
 * - Within a group, blocks are organised into subgroups. A new subgroup starts
 *   when an assistant text arrives after 5+ non-text blocks in the current
 *   subgroup — the text (and any following blocks) live under a fresh chrome.
 * - Consecutive tool_calls are collapsed into one ToolCallGroup item.
 * - User text and warning/error system messages break the agent group.
 * - Hidden/internal messages (info system, un-renderable progress) are skipped
 *   without breaking groups.
 */
export function groupMessages(messages: EnhancedMessage[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let agentGroup: AgentMessageGroup | null = null;
  let currentSubgroup: AgentSubGroup | null = null;
  let subgroupNonTextCount = 0;
  let toolCallAccumulator: ToolCallMessage[] = [];

  function ensureAgentGroup(): AgentMessageGroup {
    if (!agentGroup) {
      agentGroup = {
        kind: 'agent_message_group',
        subgroups: [],
        messages: [],
      };
    }
    return agentGroup;
  }

  function ensureSubgroup(): AgentSubGroup {
    const group = ensureAgentGroup();
    if (!currentSubgroup) {
      currentSubgroup = { items: [], messages: [] };
      group.subgroups.push(currentSubgroup);
      subgroupNonTextCount = 0;
    }
    return currentSubgroup;
  }

  function flushAccumulator(): void {
    if (toolCallAccumulator.length === 0) return;
    ensureSubgroup().items.push({
      kind: 'tool_call_group',
      messages: [...toolCallAccumulator],
    });
    toolCallAccumulator = [];
  }

  function closeSubgroup(): void {
    flushAccumulator();
    currentSubgroup = null;
    subgroupNonTextCount = 0;
  }

  function flushAgentGroup(): void {
    if (!agentGroup) return;
    closeSubgroup();
    if (agentGroup.subgroups.length > 0) {
      result.push(agentGroup);
    }
    agentGroup = null;
  }

  for (const message of messages) {
    if (isToolCallMessage(message)) {
      const group = ensureAgentGroup();
      ensureSubgroup();
      group.messages.push(message);
      currentSubgroup!.messages.push(message);
      toolCallAccumulator.push(message);
      subgroupNonTextCount++;
    } else if (isAgentBlockMessage(message)) {
      const group = ensureAgentGroup();
      ensureSubgroup();

      if (isAssistantTextMessage(message)) {
        // Text arriving on top of a heavy subgroup → break into a fresh subgroup
        // so the summary reads separately from the preceding work.
        if (subgroupNonTextCount >= SUBGROUP_TEXT_BREAK_THRESHOLD) {
          closeSubgroup();
          ensureSubgroup();
        } else {
          flushAccumulator();
        }
        currentSubgroup!.items.push({ kind: 'message', message });
        currentSubgroup!.messages.push(message);
        group.messages.push(message);
        // Text doesn't increment the non-text counter; subsequent work keeps
        // accumulating under the same subgroup unless a new header is forced.
      } else {
        flushAccumulator();
        currentSubgroup!.items.push({ kind: 'message', message });
        currentSubgroup!.messages.push(message);
        group.messages.push(message);
        subgroupNonTextCount++;
      }
    } else if (isRenderableEnhancedMessage(message)) {
      flushAgentGroup();
      result.push({ kind: 'single', message });
    }
    // Hidden/internal messages silently skipped — they don't break groups
  }

  flushAgentGroup();

  return result;
}
