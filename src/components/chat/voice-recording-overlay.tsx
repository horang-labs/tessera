'use client';

import { Square } from 'lucide-react';
import type { VoiceInputState } from '@/hooks/use-voice-input';
import { useI18n } from '@/lib/i18n';

interface VoiceRecordingOverlayProps {
  state: VoiceInputState;
  elapsedTime: number;
  volumeLevel: number;
  onStop: () => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function VoiceRecordingOverlay({
  state,
  elapsedTime,
  volumeLevel,
  onStop,
}: VoiceRecordingOverlayProps) {
  const { t } = useI18n();

  if (state === 'processing') {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[44px] px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-(--text-muted)">
          <div className="w-4 h-4 border-2 border-(--text-muted) border-t-transparent rounded-full animate-spin" />
          <span>{t('voice.convertingToText')}</span>
        </div>
      </div>
    );
  }

  // state === 'recording' — Gemini mode with volume bar
  return (
    <div className="flex-1 flex flex-col min-h-[44px] px-4 py-3 gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Red pulsing dot */}
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-(--error) opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-(--error)" />
          </span>
          <span className="text-sm text-(--text-secondary)">{t('voice.recording')}</span>
          <span className="text-sm font-mono text-(--text-muted)">
            {formatTime(elapsedTime)}
          </span>
        </div>

        <button
          onClick={onStop}
          className="p-2 rounded-md transition-all duration-150 bg-(--error) text-white hover:bg-(--destructive-hover)"
          aria-label={t('voice.stop')}
        >
          <Square className="w-4 h-4 fill-current" />
        </button>
      </div>

      {/* Volume bar */}
      <div className="h-1 bg-(--divider) rounded-full overflow-hidden">
        <div
          className="h-full bg-(--error) rounded-full transition-all duration-75"
          style={{ width: `${Math.max(volumeLevel * 100, 2)}%` }}
        />
      </div>
    </div>
  );
}
