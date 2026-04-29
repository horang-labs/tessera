'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useWebSpeech } from './use-web-speech';
import { useGeminiStt } from './use-gemini-stt';

export type VoiceInputState = 'idle' | 'recording' | 'processing';

export const MAX_RECORDING_SECONDS_GEMINI = 120;     // Gemini: 2분 (오디오 파일 전송)
export const MAX_RECORDING_SECONDS_WEBSPEECH = 600;  // Web Speech: 10분 (스트리밍, 무료)

export const IDLE_VOICE_RESULT: VoiceInputResult = {
  state: 'idle',
  elapsedTime: 0,
  volumeLevel: 0,
  interimText: '',
  committedText: '',
  pendingInterim: '',
  startRecording: () => {},
  stopRecording: () => {},
  toggleRecording: () => {},
};

export interface VoiceInputResult {
  state: VoiceInputState;
  elapsedTime: number;
  volumeLevel: number;
  interimText: string;
  committedText: string;
  pendingInterim: string;
  startRecording: () => void;
  stopRecording: () => void;
  toggleRecording: () => void;
}

interface UseVoiceInputOptions {
  onTranscribed: (text: string) => void;
}

export function useVoiceInput({ onTranscribed }: UseVoiceInputOptions): VoiceInputResult {
  const sttEngine = useSettingsStore((s) => s.settings.sttEngine);

  const webSpeech = useWebSpeech({ onTranscribed, enabled: sttEngine === 'webSpeech' });
  const gemini = useGeminiStt({ onTranscribed, enabled: sttEngine === 'gemini' });

  return sttEngine === 'webSpeech' ? webSpeech : gemini;
}
