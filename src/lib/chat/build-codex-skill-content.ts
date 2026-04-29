import type { ContentBlock } from '@/lib/ws/message-types';

/**
 * Build the provider-specific Codex payload for a selected skill invocation.
 *
 * User-facing history keeps the raw slash command string, but Codex receives
 * a typed `skill` item in the turn/start input array.
 */
export function buildCodexSkillContent(
  content: string | ContentBlock[],
  skillName: string,
  skillPath: string,
): ContentBlock[] {
  const skillBlock: Extract<ContentBlock, { type: 'skill' }> = {
    type: 'skill',
    name: skillName,
    path: skillPath,
  };

  const orderedBlocks: ContentBlock[] = typeof content === 'string'
    ? (content.trim() ? [{ type: 'text', text: content }] : [])
    : content.filter((block) => block.type !== 'skill');

  return [...orderedBlocks, skillBlock];
}
