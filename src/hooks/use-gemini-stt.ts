'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useNotificationStore } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import { MAX_RECORDING_SECONDS_GEMINI, IDLE_VOICE_RESULT, type VoiceInputResult } from './use-voice-input';

interface UseGeminiSttOptions {
  onTranscribed: (text: string) => void;
  enabled: boolean;
}

export function useGeminiStt({ onTranscribed, enabled }: UseGeminiSttOptions): VoiceInputResult {
  const { t } = useI18n();
  const [state, setState] = useState<VoiceInputResult['state']>('idle');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const onTranscribedRef = useRef(onTranscribed);

  useEffect(() => {
    onTranscribedRef.current = onTranscribed;
  }, [onTranscribed]);

  const cleanupResources = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setElapsedTime(0);
    setVolumeLevel(0);
  }, []);

  const sendToSTT = useCallback(async (audioBlob: Blob) => {
    setState('processing');
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const response = await fetch('/api/stt', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: t('errors.sttConversionFailed') }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      const { text } = await response.json();
      if (text && text.trim()) {
        onTranscribedRef.current(text.trim());
      }
    } catch (err) {
      useNotificationStore.getState().showToast(
        err instanceof Error ? err.message : t('errors.sttConversionFailed'),
        'error',
      );
    } finally {
      setState('idle');
    }
  }, [t]);

  const stopRecording = useCallback(() => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') return;
    mediaRecorderRef.current.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (state !== 'idle') return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setVolumeLevel(Math.min(avg / 128, 1));
        animationFrameRef.current = requestAnimationFrame(updateVolume);
      };
      updateVolume();

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        cleanupResources();
        if (audioBlob.size > 0) {
          sendToSTT(audioBlob);
        } else {
          setState('idle');
        }
      };

      recorder.start();
      setState('recording');

      setElapsedTime(0);
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => {
          const next = prev + 1;
          if (next >= MAX_RECORDING_SECONDS_GEMINI) {
            // Guard: only stop if still recording, clear timer to prevent duplicate calls
            if (mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop();
            }
            if (timerRef.current !== null) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      cleanupResources();
      setState('idle');

      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        useNotificationStore.getState().showToast(t('errors.microphonePermissionRequired'), 'error');
      } else {
        useNotificationStore.getState().showToast(t('errors.cannotStartMicrophone'), 'error');
      }
    }
  }, [state, cleanupResources, sendToSTT, t]);

  const toggleRecording = useCallback(() => {
    if (state === 'idle') {
      startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
  }, [state, startRecording, stopRecording]);

  // H1: Stop recording if engine switches while active
  useEffect(() => {
    if (enabled || state === 'idle') return;

    const frameId = requestAnimationFrame(() => {
      cleanupResources();
      setState('idle');
    });
    return () => cancelAnimationFrame(frameId);
  }, [cleanupResources, enabled, state]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {});
    };
  }, []);

  if (!enabled) return IDLE_VOICE_RESULT;

  return {
    state,
    elapsedTime,
    volumeLevel,
    interimText: '',
    committedText: '',
    pendingInterim: '',
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
