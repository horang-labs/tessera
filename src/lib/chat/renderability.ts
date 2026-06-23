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
      return (
        message.severity !== 'info' ||
        message.subtype === 'compact_boundary' ||
        message.subtype === 'turn_duration'
      );
    case 'progress_hook':
      return isRenderableProgressType(message.progressType);
    case 'workflow':
      // Rendered in the docked WorkflowStatusBar above the composer, not inline
      // in the message stream — keep it out of the grouped message list.
      return false;
    default:
      return false;
  }
}
