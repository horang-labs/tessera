'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useNotificationStore } from '@/stores/notification-store';
import { useSettingsStore } from '@/stores/settings-store';
import { i18n } from '@/lib/i18n';
import { MAX_RECORDING_SECONDS_WEBSPEECH, IDLE_VOICE_RESULT, type VoiceInputResult } from './use-voice-input';

// Web Speech API types (not in all TS libs)
interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onresult: ((ev: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onspeechstart: ((ev: Event) => void) | null;
  onspeechend: ((ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

type SpeechRecognitionConstructor = new () => ISpeechRecognition;

function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
}

function langCodeForSetting(lang: string): string {
  const map: Record<string, string> = { ko: 'ko-KR', en: 'en-US' };
  return map[lang] ?? lang;
}

interface UseWebSpeechOptions {
  onTranscribed: (text: string) => void;
  enabled: boolean;
}

export function useWebSpeech({ enabled }: UseWebSpeechOptions): VoiceInputResult {
  const [state, setState] = useState<VoiceInputResult['state']>('idle');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [interimText, setInterimText] = useState('');
  const [committedText, setCommittedText] = useState('');
  const [pendingInterim, setPendingInterim] = useState('');

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const manualStopRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingInterimRef = useRef('');
  const committedTextRef = useRef('');

  const cleanupTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsedTime(0);
  }, []);

  const stopRecording = useCallback(() => {
    manualStopRef.current = true;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    cleanupTimer();
    // Don't clear committedText/interimText here — let the textarea keep the text.
    // message-input.tsx reads interimText before state goes idle.
    committedTextRef.current = '';
    setState('idle');
  }, [cleanupTimer]);

  const startRecording = useCallback(() => {
    if (state !== 'idle') return;

    const Ctor = getRecognitionConstructor();
    if (!Ctor) {
      useNotificationStore.getState().showToast(
        i18n.t('errors.webSpeechNotSupported'),
        'error',
      );
      return;
    }

    manualStopRef.current = false;
    committedTextRef.current = '';
    pendingInterimRef.current = '';
    setInterimText('');
    setCommittedText('');
    setPendingInterim('');

    const language = useSettingsStore.getState().settings.language;
    const recognition = new Ctor();
    recognition.lang = langCodeForSetting(language);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setState('recording');
    };

    // interimText = committed (finalized segments) + current interim
    // message-input.tsx syncs this to the textarea in real-time
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          const finalText = transcript.trim();
          committedTextRef.current = committedTextRef.current
            ? committedTextRef.current + ' ' + finalText
            : finalText;
          pendingInterimRef.current = '';
          setCommittedText(committedTextRef.current);
          setPendingInterim('');
          setInterimText(committedTextRef.current);
        } else {
          interim += transcript;
        }
      }
      if (interim) {
        pendingInterimRef.current = interim;
        setPendingInterim(interim);
        const display = committedTextRef.current
          ? committedTextRef.current + ' ' + interim
          : interim;
        setInterimText(display);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        useNotificationStore.getState().showToast(i18n.t('errors.microphonePermissionRequired'), 'error');
        manualStopRef.current = true;
      } else if (event.error === 'no-speech') {
        // Silence timeout — will auto-restart via onend
      } else if (event.error !== 'aborted') {
        useNotificationStore.getState().showToast(i18n.t('errors.speechRecognitionError', { error: event.error }), 'error');
      }
    };

    recognition.onend = () => {
      // Flush any pending interim text to committed before restart/cleanup
      if (pendingInterimRef.current) {
        const flushed = pendingInterimRef.current.trim();
        committedTextRef.current = committedTextRef.current
          ? committedTextRef.current + ' ' + flushed
          : flushed;
        pendingInterimRef.current = '';
      }
      setCommittedText(committedTextRef.current);
      setPendingInterim('');
      setInterimText(committedTextRef.current);
      if (manualStopRef.current) {
        setState('idle');
        recognitionRef.current = null;
        cleanupTimer();
      } else {
        // Browser auto-ended (silence, network) — restart
        try {
          recognition.start();
        } catch {
          setState('idle');
          recognitionRef.current = null;
          cleanupTimer();
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();

    // Elapsed time timer
    setElapsedTime(0);
    timerRef.current = setInterval(() => {
      setElapsedTime((prev) => {
        const next = prev + 1;
        if (next >= MAX_RECORDING_SECONDS_WEBSPEECH) {
          manualStopRef.current = true;
          if (recognitionRef.current) {
            recognitionRef.current.stop();
          }
          if (timerRef.current !== null) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
        }
        return next;
      });
    }, 1000);
  }, [state, cleanupTimer]);

  const toggleRecording = useCallback(() => {
    if (state === 'idle') {
      startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
  }, [state, startRecording, stopRecording]);

  // H1: Stop recognition if engine switches while active
  useEffect(() => {
    if (!enabled && state !== 'idle') {
      manualStopRef.current = true;
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
      committedTextRef.current = '';
      const frameId = requestAnimationFrame(() => {
        cleanupTimer();
        setState('idle');
        setInterimText('');
        setCommittedText('');
        setPendingInterim('');
      });
      return () => cancelAnimationFrame(frameId);
    }
  }, [cleanupTimer, enabled, state]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        manualStopRef.current = true;
        recognitionRef.current.stop();
      }
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  if (!enabled) return IDLE_VOICE_RESULT;

  return {
    state,
    elapsedTime,
    volumeLevel: 0,
    interimText,
    committedText,
    pendingInterim,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
