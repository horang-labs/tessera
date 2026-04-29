'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useNotificationStore } from '@/stores/notification-store';
import type { ContentBlock } from '@/lib/ws/message-types';

const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

type SupportedMimeType = typeof SUPPORTED_IMAGE_MIME_TYPES[number];
type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

export interface ImageAttachment {
  kind: 'image';
  id: number;
  blob: Blob;
  base64: string;
  mediaType: SupportedMimeType;
  previewUrl: string;
}

export interface FileAttachment {
  kind: 'file';
  id: number;
  fileName: string;
  serverPath: string;
}

export type AttachmentItem = ImageAttachment | FileAttachment;

interface UseMessageInputAttachmentsOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  t: TranslateFn;
}

function createImageAttachmentPlaceholder(id: number): string {
  return `[📷 ${id}]`;
}

function createFileAttachmentPlaceholder(id: number): string {
  return `[📎 ${id}]`;
}

function insertPlaceholderAtCursor(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  setInputValue: React.Dispatch<React.SetStateAction<string>>,
  placeholder: string,
) {
  const textarea = textareaRef.current;
  if (!textarea) {
    return;
  }

  const cursorPos = textarea.selectionStart;
  const currentValue = textarea.value;
  const nextValue = currentValue.slice(0, cursorPos) + placeholder + currentValue.slice(cursorPos);

  setInputValue(nextValue);

  requestAnimationFrame(() => {
    const nextCursorPos = cursorPos + placeholder.length;
    textarea.setSelectionRange(nextCursorPos, nextCursorPos);
    textarea.focus();
  });
}

async function uploadFileToServer(file: File): Promise<{ path: string; fileName: string }> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Upload failed (${response.status})`);
  }

  return response.json();
}

function revokeAttachmentPreview(attachment: AttachmentItem) {
  if (attachment.kind === 'image') {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

function revokeAttachmentPreviews(attachments: AttachmentItem[]) {
  attachments.forEach(revokeAttachmentPreview);
}

function collectAttachmentIds(text: string): Set<number> {
  const attachmentIds = new Set<number>();
  const regex = /\[(?:📷|📎)\s*(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    attachmentIds.add(Number(match[1]));
  }

  return attachmentIds;
}

function splitAttachments(attachments: AttachmentItem[]) {
  const imageAttachments: ImageAttachment[] = [];
  const fileAttachments: FileAttachment[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      imageAttachments.push(attachment);
      continue;
    }

    fileAttachments.push(attachment);
  }

  return { fileAttachments, imageAttachments };
}

function buildImageAttachmentContent(
  text: string,
  imageAttachments: ImageAttachment[],
): string | ContentBlock[] {
  if (imageAttachments.length === 0) {
    return text;
  }

  const regex = /\[📷\s*(\d+)\]/g;
  const blocks: ContentBlock[] = [];
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
    if (attachment) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mediaType,
          data: attachment.base64,
        },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const segment = text.slice(lastIndex).trim();
    if (segment) {
      blocks.push({ type: 'text', text: segment });
    }
  }

  return blocks.length > 0 ? blocks : text;
}

export function buildMessageInputSendContent(
  text: string,
  attachments: AttachmentItem[],
): string | ContentBlock[] {
  if (attachments.length === 0) {
    return text;
  }

  const { fileAttachments, imageAttachments } = splitAttachments(attachments);
  let resolvedText = text;

  for (const attachment of fileAttachments) {
    resolvedText = resolvedText
      .split(createFileAttachmentPlaceholder(attachment.id))
      .join(attachment.serverPath);
  }

  return buildImageAttachmentContent(resolvedText, imageAttachments);
}

export function buildMessageInputDisplayContent(
  text: string,
  attachments: AttachmentItem[],
): string | ContentBlock[] {
  if (attachments.length === 0) {
    return text;
  }

  const { fileAttachments, imageAttachments } = splitAttachments(attachments);
  let resolvedText = text;

  for (const attachment of fileAttachments) {
    resolvedText = resolvedText
      .split(createFileAttachmentPlaceholder(attachment.id))
      .join(`📎 ${attachment.fileName}`);
  }

  return buildImageAttachmentContent(resolvedText, imageAttachments);
}

export function useMessageInputAttachments({
  textareaRef,
  setInputValue,
  t,
}: UseMessageInputAttachmentsOptions) {
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const attachmentCounterRef = useRef(0);
  const attachmentsRef = useRef<AttachmentItem[]>([]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      revokeAttachmentPreviews(attachmentsRef.current);
    };
  }, []);

  const handleImageAttachment = useCallback((file: File) => {
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      useNotificationStore.getState().showToast(
        t('validation.imageTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }),
        'error',
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const dataUrl = loadEvent.target?.result as string | null;
      if (!dataUrl) {
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      const newAttachment: ImageAttachment = {
        kind: 'image',
        id: ++attachmentCounterRef.current,
        blob: file,
        base64: dataUrl.split(',')[1],
        mediaType: file.type as SupportedMimeType,
        previewUrl,
      };

      setAttachments((currentAttachments) => {
        const imageCount = currentAttachments.filter((attachment) => attachment.kind === 'image').length;
        if (imageCount >= MAX_IMAGES) {
          URL.revokeObjectURL(previewUrl);
          return currentAttachments;
        }

        return [...currentAttachments, newAttachment];
      });

      insertPlaceholderAtCursor(
        textareaRef,
        setInputValue,
        createImageAttachmentPlaceholder(newAttachment.id),
      );
    };

    reader.onerror = () => {
      useNotificationStore.getState().showToast(t('validation.imageReadFailed'), 'error');
    };

    reader.readAsDataURL(file);
  }, [setInputValue, t, textareaRef]);

  const handleUploadedFileAttachment = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      useNotificationStore.getState().showToast(
        t('validation.fileTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }),
        'error',
      );
      return;
    }

    try {
      const result = await uploadFileToServer(file);
      const newAttachment: FileAttachment = {
        kind: 'file',
        id: ++attachmentCounterRef.current,
        fileName: result.fileName,
        serverPath: result.path,
      };

      setAttachments((currentAttachments) => [...currentAttachments, newAttachment]);
      insertPlaceholderAtCursor(
        textareaRef,
        setInputValue,
        createFileAttachmentPlaceholder(newAttachment.id),
      );
    } catch {
      useNotificationStore.getState().showToast(
        t('validation.fileUploadFailed', { fileName: file.name }),
        'error',
      );
    }
  }, [setInputValue, t, textareaRef]);

  const processSelectedFiles = useCallback(async (files: File[]) => {
    let nextImageCount = attachmentsRef.current.filter((attachment) => attachment.kind === 'image').length;

    for (const file of files) {
      if (SUPPORTED_IMAGE_MIME_TYPES.includes(file.type as SupportedMimeType)) {
        if (nextImageCount >= MAX_IMAGES) {
          useNotificationStore.getState().showToast(
            t('validation.maxImagesExceeded', { max: MAX_IMAGES }),
            'error',
          );
          break;
        }

        nextImageCount += 1;
        handleImageAttachment(file);
        continue;
      }

      await handleUploadedFileAttachment(file);
    }
  }, [handleImageAttachment, handleUploadedFileAttachment, t]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'));

    if (imageItems.length === 0) {
      return;
    }

    event.preventDefault();
    let nextImageCount = attachmentsRef.current.filter((attachment) => attachment.kind === 'image').length;

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) {
        continue;
      }

      if (!SUPPORTED_IMAGE_MIME_TYPES.includes(blob.type as SupportedMimeType)) {
        useNotificationStore.getState().showToast(
          t('validation.unsupportedImageFormat', { format: blob.type }),
          'error',
        );
        continue;
      }

      if (nextImageCount >= MAX_IMAGES) {
        useNotificationStore.getState().showToast(
          t('validation.maxImagesExceeded', { max: MAX_IMAGES }),
          'error',
        );
        break;
      }

      nextImageCount += 1;
      handleImageAttachment(blob);
    }
  }, [handleImageAttachment, t]);

  const handleFileDrop = useCallback(async (files: File[]) => {
    await processSelectedFiles(files);
  }, [processSelectedFiles]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';

    if (files.length === 0) {
      return;
    }

    void processSelectedFiles(files);
  }, [processSelectedFiles]);

  const handleRemoveAttachment = useCallback((id: number) => {
    setAttachments((currentAttachments) => {
      const targetAttachment = currentAttachments.find((attachment) => attachment.id === id);
      if (targetAttachment) {
        revokeAttachmentPreview(targetAttachment);
      }

      return currentAttachments.filter((attachment) => attachment.id !== id);
    });

    setInputValue((currentValue) =>
      currentValue
        .split(createImageAttachmentPlaceholder(id)).join('')
        .split(createFileAttachmentPlaceholder(id)).join(''),
    );
  }, [setInputValue]);

  const syncAttachmentsWithText = useCallback((text: string) => {
    const attachmentIds = collectAttachmentIds(text);

    setAttachments((currentAttachments) => {
      const removedAttachments = currentAttachments.filter(
        (attachment) => !attachmentIds.has(attachment.id),
      );

      if (removedAttachments.length === 0) {
        return currentAttachments;
      }

      revokeAttachmentPreviews(removedAttachments);
      return currentAttachments.filter((attachment) => attachmentIds.has(attachment.id));
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((currentAttachments) => {
      revokeAttachmentPreviews(currentAttachments);
      return [];
    });
  }, []);

  return {
    attachments,
    buildDisplayContent: buildMessageInputDisplayContent,
    buildSendContent: buildMessageInputSendContent,
    clearAttachments,
    handleFileDrop,
    handleFileSelect,
    handlePaste,
    handleRemoveAttachment,
    syncAttachmentsWithText,
  };
}
