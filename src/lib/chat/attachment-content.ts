import type { ContentBlock } from '@/lib/ws/message-types';

/**
 * Building the outgoing content for a message that carries attachments.
 *
 * The composer marks each attachment with a placeholder inside the textarea — `[📷 1]` for
 * an image, `[📎 2]` for an uploaded file — so the user can see where it sits and move it
 * around. These builders turn that text back into what the CLI receives.
 *
 * A placeholder is ordinary editable text, so it can go missing while the attachment is
 * still attached: rewriting the message, switching sessions, any programmatic edit of the
 * field. Everything a placeholder is matched to is placed where it sits; everything left
 * over is still delivered, after the text. Dropping it would lose an attachment the user
 * can see in the composer, which is what #254 was.
 */

export interface ImageAttachmentContent {
  kind: 'image';
  id: number;
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface FileAttachmentContent {
  kind: 'file';
  id: number;
  fileName: string;
  serverPath: string;
}

export type AttachmentContentItem = ImageAttachmentContent | FileAttachmentContent;

export function createImageAttachmentPlaceholder(id: number): string {
  return `[📷 ${id}]`;
}

export function createFileAttachmentPlaceholder(id: number): string {
  return `[📎 ${id}]`;
}

export function collectAttachmentIds(text: string): Set<number> {
  const attachmentIds = new Set<number>();
  const regex = /\[(?:📷|📎)\s*(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    attachmentIds.add(Number(match[1]));
  }

  return attachmentIds;
}

/**
 * Take the markers of `attachments` out of `text`, leaving everything else —
 * including markers belonging to attachments that are not being discarded.
 *
 * Used when attachments are dropped without the draft being cleared, so the
 * draft is never left naming an attachment that no longer exists: the CLI would
 * be handed `[📷 1]` as literal text.
 */
export function dropAttachmentPlaceholders(
  text: string,
  attachments: AttachmentContentItem[],
): string {
  if (attachments.length === 0) {
    return text;
  }

  let remaining = text;
  for (const attachment of attachments) {
    const placeholder = attachment.kind === 'image'
      ? createImageAttachmentPlaceholder(attachment.id)
      : createFileAttachmentPlaceholder(attachment.id);
    remaining = remaining.split(placeholder).join('');
  }

  return remaining.replace(/[^\S\n]{2,}/g, ' ').trim();
}

function splitAttachments(attachments: AttachmentContentItem[]) {
  const imageAttachments: ImageAttachmentContent[] = [];
  const fileAttachments: FileAttachmentContent[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      imageAttachments.push(attachment);
      continue;
    }

    fileAttachments.push(attachment);
  }

  return { fileAttachments, imageAttachments };
}

function toImageBlock(attachment: ImageAttachmentContent): ContentBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: attachment.mediaType,
      data: attachment.base64,
    },
  };
}

/**
 * Replace each file placeholder with `render(attachment)`, and append whatever the text
 * no longer refers to on its own line so the CLI still receives it.
 */
function resolveFileAttachments(
  text: string,
  fileAttachments: FileAttachmentContent[],
  render: (attachment: FileAttachmentContent) => string,
): string {
  const referencedIds = collectAttachmentIds(text);
  let resolvedText = text;
  const orphaned: string[] = [];

  for (const attachment of fileAttachments) {
    if (referencedIds.has(attachment.id)) {
      resolvedText = resolvedText
        .split(createFileAttachmentPlaceholder(attachment.id))
        .join(render(attachment));
      continue;
    }

    orphaned.push(render(attachment));
  }

  if (orphaned.length === 0) {
    return resolvedText;
  }

  return [resolvedText.trim(), ...orphaned].filter(Boolean).join('\n');
}

function buildImageAttachmentContent(
  text: string,
  imageAttachments: ImageAttachmentContent[],
): string | ContentBlock[] {
  if (imageAttachments.length === 0) {
    return text;
  }

  const regex = /\[📷\s*(\d+)\]/g;
  const blocks: ContentBlock[] = [];
  const placedIds = new Set<number>();
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index).trim();
      if (segment) {
        blocks.push({ type: 'text', text: segment });
      }
    }

    const imageId = Number(match[1]);
    const attachment = imageAttachments.find((item) => item.id === imageId);
    if (attachment && !placedIds.has(imageId)) {
      placedIds.add(imageId);
      blocks.push(toImageBlock(attachment));
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const segment = text.slice(lastIndex).trim();
    if (segment) {
      blocks.push({ type: 'text', text: segment });
    }
  }

  for (const attachment of imageAttachments) {
    if (placedIds.has(attachment.id)) continue;
    blocks.push(toImageBlock(attachment));
  }

  return blocks.length > 0 ? blocks : text;
}

/** What the CLI receives: image bytes inline, uploaded files as paths it can read. */
export function buildMessageInputSendContent(
  text: string,
  attachments: AttachmentContentItem[],
): string | ContentBlock[] {
  if (attachments.length === 0) {
    return text;
  }

  const { fileAttachments, imageAttachments } = splitAttachments(attachments);
  const resolvedText = resolveFileAttachments(
    text,
    fileAttachments,
    (attachment) => attachment.serverPath,
  );

  return buildImageAttachmentContent(resolvedText, imageAttachments);
}

/** What the sent bubble shows: the same images, uploaded files by name rather than path. */
export function buildMessageInputDisplayContent(
  text: string,
  attachments: AttachmentContentItem[],
): string | ContentBlock[] {
  if (attachments.length === 0) {
    return text;
  }

  const { fileAttachments, imageAttachments } = splitAttachments(attachments);
  const resolvedText = resolveFileAttachments(
    text,
    fileAttachments,
    (attachment) => `📎 ${attachment.fileName}`,
  );

  return buildImageAttachmentContent(resolvedText, imageAttachments);
}
