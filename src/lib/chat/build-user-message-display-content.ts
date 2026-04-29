import type { ContentBlock, TextContentBlock } from '@/lib/ws/message-types';

/**
 * Build the user-visible chat content for a skill invocation.
 *
 * Transport may keep `skillName` separate from `content`, but chat history
 * should preserve the exact command the user saw in the UI.
 */
export function buildUserMessageDisplayContent(
  content: string | ContentBlock[],
  skillName?: string,
): string | ContentBlock[] {
  if (!skillName) return content;

  if (typeof content === 'string') {
    return content ? `/${skillName} ${content}` : `/${skillName}`;
  }

  const blocks = [...content];
  const firstTextIdx = blocks.findIndex((block): block is TextContentBlock => block.type === 'text');

  if (firstTextIdx >= 0) {
    const textBlock = blocks[firstTextIdx] as TextContentBlock;
    blocks[firstTextIdx] = {
      type: 'text',
      text: textBlock.text ? `/${skillName} ${textBlock.text}` : `/${skillName}`,
    };
    return blocks;
  }

  return [{ type: 'text', text: `/${skillName}` }, ...blocks];
}
