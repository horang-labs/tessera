'use client';

import Image from 'next/image';
import { FileText } from 'lucide-react';
import type { SessionRefItem } from '@/types/session-ref';
import type { AttachmentItem } from '@/hooks/use-message-input-attachments';
import { SessionRefChip } from './session-ref-chip';

interface MessageInputAttachmentStripProps {
  attachments: AttachmentItem[];
  onRemoveAttachment: (id: number) => void;
  renderAttachmentAlt: (id: number) => string;
  renderRemoveLabel: (id: number) => string;
}

interface MessageInputSessionRefStripProps {
  refs: SessionRefItem[];
  onRemoveRef: (slot: number) => void;
  onRetryRef: (slot: number) => void;
}

interface MessageInputWebSpeechBarProps {
  elapsedTime: number;
  onStop: () => void;
  recordingLabel: string;
  stopLabel: string;
}

interface MessageInputSkillChipProps {
  skillName: string;
  removeTooltip: string;
  onRemove: () => void;
}

function formatElapsedTime(elapsedTime: number): string {
  return `${Math.floor(elapsedTime / 60)}:${String(elapsedTime % 60).padStart(2, '0')}`;
}

export function MessageInputAttachmentStrip({
  attachments,
  onRemoveAttachment,
  renderAttachmentAlt,
  renderRemoveLabel,
}: MessageInputAttachmentStripProps) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-2 px-3 pt-2 pb-1 overflow-x-auto">
      {attachments.map((attachment) => {
        if (attachment.kind === 'image') {
          return (
            <div
              key={attachment.id}
              className="relative shrink-0 w-[100px] h-[100px] rounded-lg overflow-hidden border border-(--divider) group"
            >
              <Image
                src={attachment.previewUrl}
                alt={renderAttachmentAlt(attachment.id)}
                fill
                unoptimized
                sizes="100px"
                className="object-cover"
              />
              <span className="absolute bottom-1 left-1 text-[10px] bg-black/60 text-white px-1 rounded">
                📷 {attachment.id}
              </span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={renderRemoveLabel(attachment.id)}
              >
                &times;
              </button>
            </div>
          );
        }

        return (
          <div
            key={attachment.id}
            className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-(--divider) bg-(--bg-secondary) group max-w-[220px]"
          >
            <FileText className="w-4 h-4 shrink-0 text-(--text-muted)" />
            <span
              className="text-xs text-(--text-secondary) truncate"
              title={attachment.fileName}
            >
              {attachment.fileName}
            </span>
            <button
              type="button"
              onClick={() => onRemoveAttachment(attachment.id)}
              className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-(--text-muted) hover:text-(--text-primary) text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={renderRemoveLabel(attachment.id)}
            >
              &times;
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function MessageInputSessionRefStrip({
  refs,
  onRemoveRef,
  onRetryRef,
}: MessageInputSessionRefStripProps) {
  if (refs.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-1.5 px-3 pt-2 pb-1 overflow-x-auto flex-wrap">
      {refs.map((ref) => (
        <SessionRefChip
          key={ref.slot}
          item={ref}
          onRemove={() => onRemoveRef(ref.slot)}
          onRetry={() => onRetryRef(ref.slot)}
        />
      ))}
    </div>
  );
}

export function MessageInputWebSpeechBar({
  elapsedTime,
  onStop,
  recordingLabel,
  stopLabel,
}: MessageInputWebSpeechBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-(--divider)">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-(--error) opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-(--error)" />
        </span>
        <span className="text-xs text-(--text-secondary)">{recordingLabel}</span>
        <span className="text-xs font-mono text-(--text-muted)">
          {formatElapsedTime(elapsedTime)}
        </span>
      </div>
      <button
        onClick={onStop}
        className="px-2 py-1 rounded-md text-xs font-medium transition-all duration-150 bg-(--error) text-white hover:bg-(--destructive-hover)"
        aria-label={stopLabel}
      >
        {stopLabel}
      </button>
    </div>
  );
}

export function MessageInputSkillChip({
  skillName,
  removeTooltip,
  onRemove,
}: MessageInputSkillChipProps) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="ml-3 shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-(--accent)/20 text-(--accent-light) border border-(--accent)/40 hover:bg-(--accent)/30 transition-colors cursor-pointer"
      title={removeTooltip}
    >
      <span>/{skillName}</span>
      <span className="text-(--text-muted) text-[10px] ml-0.5">&times;</span>
    </button>
  );
}
