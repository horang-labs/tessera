/**
 * Shared message parsing utilities
 *
 * Pure functions for parsing Claude CLI JSONL message content blocks.
 * Used by the live stdout parsers for Claude-compatible providers.
 *
 * DESIGN CONSTRAINT: Zero dependencies on project modules.
 * No imports from logger, process-manager, or WebSocket code.
 */

/**
 * Parsed content block -- discriminated union of all block types
 * that can appear in assistant message content arrays.
 */
export type ParsedContentBlock =
  | ParsedTextBlock
  | ParsedToolUseBlock
  | ParsedThinkingBlock
  | ParsedRedactedThinkingBlock;

export interface ParsedTextBlock {
  type: 'text';
  text: string;
}

export interface ParsedToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ParsedThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ParsedRedactedThinkingBlock {
  type: 'redacted_thinking';
  data?: string;
}

/**
 * Result of extracting output from a tool_result content block.
 */
export interface ExtractedToolResult {
  toolUseId: string;
  isError: boolean;
  output: string;
}

/**
 * Parse a single content block from an assistant message.
 *
 * @param block - Raw content block from msg.message.content[]
 * @returns Typed ParsedContentBlock or null if unrecognized type
 */
export function parseContentBlock(block: any): ParsedContentBlock | null {
  if (!block || typeof block !== 'object') {
    return null;
  }

  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text || '',
      };

    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input || {},
      };

    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking || '',
        signature: block.signature,
      };

    case 'redacted_thinking':
      return {
        type: 'redacted_thinking',
        data: block.data,
      };

    default:
      return null;
  }
}

/**
 * Parse an array of content blocks from an assistant message.
 *
 * @param blocks - Raw content blocks array from msg.message.content
 * @returns Array of parsed blocks, filtering out unrecognized types
 */
export function parseContentBlocks(blocks: any[]): ParsedContentBlock[] {
  if (!Array.isArray(blocks)) {
    return [];
  }
  return blocks.map(parseContentBlock).filter((b): b is ParsedContentBlock => b !== null);
}

/**
 * Extract tool result output from a tool_result content block.
 *
 * @param block - Single content block from a user message's content array
 * @returns Extracted tool result info or null if not a tool_result block
 */
export function extractToolResultOutput(block: any): ExtractedToolResult | null {
  if (!block || typeof block !== 'object') {
    return null;
  }

  if (block.type !== 'tool_result' || !block.tool_use_id) {
    return null;
  }

  const isError = block.is_error || false;
  const output = extractOutputString(block.content);

  return {
    toolUseId: block.tool_use_id,
    isError,
    output,
  };
}

/**
 * Extract all tool results from a user message's content blocks.
 *
 * @param blocks - Content blocks array from a user message
 * @returns Array of extracted tool results
 */
export function extractToolResults(blocks: any[]): ExtractedToolResult[] {
  if (!Array.isArray(blocks)) {
    return [];
  }
  return blocks.map(extractToolResultOutput).filter((r): r is ExtractedToolResult => r !== null);
}

/**
 * Extract plain text from a tool result content field.
 * Handles string, array of {text} objects, or returns empty string.
 *
 * @param content - The content field from a tool_result block or message
 * @returns Plain text output
 */
export function extractOutputString(content: any): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || '').join('');
  }
  return '';
}
