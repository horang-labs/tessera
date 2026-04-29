import type { EnhancedMessage } from '@/types/chat';

const RENDERABLE_PROGRESS_TYPES = new Set([
  'agent_progress',
  'mcp_progress',
]);

export function isRenderableProgressType(progressType?: string): boolean {
  return typeof progressType === 'string' && RENDERABLE_PROGRESS_TYPES.has(progressType);
}

export function isRenderableEnhancedMessage(message: EnhancedMessage): boolean {
  switch (message.type) {
    case 'text':
    case 'tool_call':
    case 'thinking':
      return true;
    case 'system':
      return message.severity !== 'info';
    case 'progress_hook':
      return isRenderableProgressType(message.progressType);
    default:
      return false;
  }
}
