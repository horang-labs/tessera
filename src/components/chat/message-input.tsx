'use client';

import { useRef, useEffect, useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { MessageSquarePlus, MessageSquareShare, Mic, Paperclip, SendHorizontal, Square } from 'lucide-react';
import {
  selectHasActiveAssistantText,
  selectIsTurnInFlight,
  useChatStore,
} from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useWebSocket } from '@/hooks/use-websocket';
import { useSessionResume } from '@/hooks/use-session-resume';
import { useSkillPicker } from '@/hooks/use-skill-picker';
import { SkillPicker } from '@/components/chat/skill-picker';
import { useFilePicker } from '@/hooks/use-file-picker';
import { FilePicker } from '@/components/chat/file-picker';
import { Separator } from '@/components/ui/separator';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import {
  applyProviderSessionRuntimeOverrides,
  getProviderSessionRuntimeConfig,
} from '@/lib/settings/provider-defaults';
import { hasConversationHistory, shouldResumeBeforeSend } from '@/lib/chat/session-send-routing';
import { toast } from '@/stores/notification-store';
import { useVoiceInput } from '@/hooks/use-voice-input';
import { useMessageInputAttachments } from '@/hooks/use-message-input-attachments';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { VoiceRecordingOverlay } from './voice-recording-overlay';
import { tinykeys } from 'tinykeys';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ContextStatusBar } from './context-status-bar';
import { SkillQuickAccessBar } from './skill-quick-access-bar';
import { useSessionRefs } from '@/hooks/use-session-refs';
import { MessageRowShell } from './message-row-shell';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';
import { SESSION_DRAG_MIME } from '@/types/panel';
import { PanelSplitPicker } from './panel-split-picker';
import { ComposerSessionControls } from './composer-session-controls';
import { useEffectiveShortcut } from '@/hooks/use-effective-shortcut';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { exportSessionReference, formatContinueConversationPrompt } from '@/lib/session/session-reference';
import { CollectionQuickCreateSheet } from './collection-quick-create-sheet';
import type { Collection } from '@/types/collection';
import {
  MessageInputAttachmentStrip,
  MessageInputSessionRefStrip,
  MessageInputSkillChip,
  MessageInputWebSpeechBar,
} from './message-input-sections';

interface MessageInputProps {
  sessionId: string;
  isDisabled: boolean;
  isReadOnly?: boolean;
  isStopped?: boolean;
  isSinglePanel?: boolean;
}

const EMPTY_COLLECTIONS: Collection[] = [];

export function MessageInput({ sessionId, isDisabled, isReadOnly, isStopped, isSinglePanel = false }: MessageInputProps) {
  const { t } = useI18n();
  const setDraftInput = useChatStore((state) => state.setDraftInput);
  const [inputValue, setInputValue] = useState(() => useChatStore.getState().getDraftInput(sessionId));
  const clearInput = useCallback(() => {
    setInputValue('');
    setDraftInput(sessionId, '');
  }, [sessionId, setDraftInput]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quickCreateTriggerRef = useRef<HTMLDivElement>(null);
  const [fileDragDepth, setFileDragDepth] = useState(0);
  const [isQuickCreateOpen, setIsQuickCreateOpen] = useState(false);
  const [isInjectingCurrentSession, setIsInjectingCurrentSession] = useState(false);
  const isFileDragOver = fileDragDepth > 0;

  // Restore draft input when switching sessions
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      setDraftInput(prevSessionIdRef.current, inputValue);
      const draft = useChatStore.getState().getDraftInput(sessionId);
      setInputValue(draft);
      prevSessionIdRef.current = sessionId;
      setFileDragDepth(0);
      if (draft && textareaRef.current) {
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(draft.length, draft.length);
        });
      }
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isTurnInFlight = useChatStore(selectIsTurnInFlight(sessionId));
  const hasActiveAssistantText = useChatStore(selectHasActiveAssistantText(sessionId));
  const activePrompt = useChatStore((state) => state.activeInteractivePrompt.get(sessionId));
  const hasExistingConversation = useChatStore((state) =>
    hasConversationHistory(state.messages.get(sessionId))
  );
  const addMessage = useChatStore((state) => state.addMessage);
  const session = useSessionStore((state) => state.getSession(sessionId));
  const projects = useSessionStore((state) => state.projects);
  const sessionStatus = session && 'status' in session ? session.status : 'running';
  const { sendMessage, cancelGeneration } = useWebSocket();
  const { resumeAndSend } = useSessionResume();
  const enterKeyBehavior = useSettingsStore(
    (state) => state.settings.enterKeyBehavior ?? 'send'
  );
  const fontSize = useSettingsStore((state) => state.settings.fontSize);
  const sttEngine = useSettingsStore((state) => state.settings.sttEngine);
  const isElectron = useElectronPlatform() !== null;

  const sessionIsRunning = session?.isRunning ?? false;
  const skillPicker = useSkillPicker(sessionId, session?.provider, sessionIsRunning);
  const filePicker = useFilePicker(sessionId);

  const getInputValue = useCallback(() => inputValue, [inputValue]);
  const sessionRefs = useSessionRefs({
    textareaRef,
    setInputValue,
    getInputValue,
  });
  const {
    addSessionRef,
    clearRefs: clearSessionRefs,
    handleDragEnter: handleSessionRefDragEnter,
    handleDragLeave: handleSessionRefDragLeave,
    handleDragOver: handleSessionRefDragOver,
    handleDrop: handleSessionRefDrop,
    hasRefs: hasSessionRefs,
    isDragOver: isSessionRefDragOver,
    refs: sessionRefItems,
    removeRef: removeSessionRef,
    resolveRefs: resolveSessionRefs,
    retryRef: retrySessionRef,
    syncRefsWithText: syncSessionRefsWithText,
    validateRefsReady: validateSessionRefsReady,
  } = sessionRefs;

  const {
    attachments,
    buildDisplayContent,
    buildSendContent,
    clearAttachments,
    handleFileDrop,
    handleFileSelect,
    handlePaste,
    handleRemoveAttachment,
    syncAttachmentsWithText,
  } = useMessageInputAttachments({
    textareaRef,
    setInputValue,
    t,
  });
  const MAX_CHARS = 10000;
  const MAX_ROWS = 5;

  const isInputUnavailable = isReadOnly || isDisabled;
  const isGenerating = sessionStatus === 'running' && (
    isTurnInFlight || hasActiveAssistantText
  );
  const activeProject = useMemo(() => {
    if (!session) return null;
    return projects.find((project) =>
      project.encodedDir === session.projectDir ||
      project.decodedPath === session.projectDir ||
      project.decodedPath === session.workDir
    ) ?? null;
  }, [projects, session]);
  const activeProjectId = activeProject?.encodedDir ?? null;
  const collections = useCollectionStore((state) =>
    activeProjectId ? state.collectionsByProject?.[activeProjectId] ?? EMPTY_COLLECTIONS : EMPTY_COLLECTIONS
  );
  const activeCollection = useMemo(() => {
    if (!session?.collectionId) return null;
    return collections.find((collection) => collection.id === session.collectionId) ?? null;
  }, [collections, session?.collectionId]);

  useEffect(() => {
    if (!activeProjectId) return;
    void useCollectionStore.getState().loadCollections(activeProjectId);
  }, [activeProjectId]);

  // Voice input: insert transcribed text at cursor position
  const handleVoiceTranscribed = useCallback((text: string) => {
    const textarea = textareaRef.current;
    if (textarea) {
      const cursorPos = textarea.selectionStart;
      const currentValue = textarea.value;
      const prefix = currentValue.slice(0, cursorPos);
      const suffix = currentValue.slice(cursorPos);
      const separator = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : '';
      const newValue = prefix + separator + text + suffix;
      setInputValue(newValue);
      requestAnimationFrame(() => {
        const newPos = cursorPos + separator.length + text.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
      });
    } else {
      setInputValue((prev) => (prev ? prev + ' ' + text : text));
    }
  }, []);

  const voiceInput = useVoiceInput({ onTranscribed: handleVoiceTranscribed });
  const {
    committedText: voiceCommittedText,
    elapsedTime: voiceElapsedTime,
    pendingInterim: voicePendingInterim,
    state: voiceState,
    stopRecording: stopVoiceRecording,
    toggleRecording: toggleVoiceRecording,
    volumeLevel: voiceVolumeLevel,
  } = voiceInput;
  const isVoiceActive = voiceState !== 'idle';
  const isWebSpeechActive = isVoiceActive && sttEngine === 'webSpeech';
  const showVoiceInput = !isElectron;
  const canUseVoice = showVoiceInput && !isDisabled && !isGenerating;

  const voiceKey = useEffectiveShortcut('voice-input');

  // Web Speech: sync only the pendingInterim portion at the end of textarea.
  // Committed (finalized) text becomes user-owned and editable — never overwritten.
  const prevPendingRef = useRef('');
  const prevCommittedRef = useRef('');

  useEffect(() => {
    if (!isWebSpeechActive) {
      prevPendingRef.current = '';
      prevCommittedRef.current = '';
      return;
    }

    const oldPending = prevPendingRef.current;
    const oldCommitted = prevCommittedRef.current;

    let base = inputValue;

    // Step 1: Remove old pending interim from the end of textarea
    if (oldPending) {
      const withSep = ' ' + oldPending;
      if (base.endsWith(withSep)) {
        base = base.slice(0, -withSep.length);
      } else if (base.endsWith(oldPending)) {
        base = base.slice(0, -oldPending.length);
      }
      // If old pending can't be found at end, user edited the interim region —
      // fall back to keeping current text as-is and just appending new content.
    }

    // Step 2: If committed text grew, append the new portion
    if (voiceCommittedText.length > oldCommitted.length) {
      const newPortion = voiceCommittedText.slice(oldCommitted.length).trimStart();
      if (newPortion) {
        const sep = base && !base.endsWith(' ') ? ' ' : '';
        base += sep + newPortion;
      }
    }

    // Step 3: Append new pending interim
    if (voicePendingInterim) {
      const sep = base && !base.endsWith(' ') ? ' ' : '';
      base += sep + voicePendingInterim;
    }

    if (base !== inputValue) {
      setInputValue(base);
    }

    prevPendingRef.current = voicePendingInterim;
    prevCommittedRef.current = voiceCommittedText;
  }, [isWebSpeechActive, voiceCommittedText, voicePendingInterim]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const resizeTextarea = () => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.style.height = 'auto';
      const computedStyle = window.getComputedStyle(textarea);
      const lineHeight = parseFloat(computedStyle.lineHeight) || textarea.getBoundingClientRect().height;
      const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
      const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
      const verticalPadding = paddingTop + paddingBottom;
      const scrollHeight = Math.ceil(textarea.scrollHeight);
      const rows = isWebSpeechActive ? 20 : MAX_ROWS;
      const maxHeight = Math.ceil(lineHeight * rows + verticalPadding);
      textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
      // Auto-scroll to bottom during voice input
      if (isWebSpeechActive) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    resizeTextarea();
    const frame = requestAnimationFrame(resizeTextarea);
    return () => cancelAnimationFrame(frame);
  }, [inputValue, isWebSpeechActive, fontSize]);

  // 마운트 시 활성 패널이면 자동 포커스 (스켈레톤 → ChatArea 전환 후 첫 렌더)
  useEffect(() => {
    const ps = usePanelStore.getState();
    const tabData = selectActiveTab(ps);
    const activePanelId = tabData?.activePanelId ?? '';
    const panels = tabData?.panels ?? {};
    if (panels[activePanelId]?.sessionId === sessionId) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [sessionId]);

  // 프롬프트 해제 후 textarea 자동 재포커스
  const prevActivePromptRef = useRef(activePrompt);
  useEffect(() => {
    const wasActive = prevActivePromptRef.current;
    prevActivePromptRef.current = activePrompt;

    // prompt가 있었다가 → null이 됨 = 응답 완료 → 포커스 복귀
    if (wasActive && !activePrompt) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [activePrompt]);

  const handleCancel = useCallback(() => {
    cancelGeneration(sessionId);
  }, [cancelGeneration, sessionId]);

  // Global ESC/Enter: 음성 녹음 중지 전용 (활성 패널 한정)
  // 생성 취소(ESC)는 전역 리스너가 아닌 textarea onKeyDown에서 처리한다 —
  // 전역으로 두면 모달/IME/드롭다운의 ESC와 충돌해서 의도치 않게 생성이 중단됨.
  useEffect(() => {
    if (voiceState !== 'recording') return;

    const handleGlobalKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      const panelState = usePanelStore.getState();
      const tabData = selectActiveTab(panelState);
      const panelActiveSessionId = tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
      if (sessionId !== panelActiveSessionId) return;

      e.preventDefault();
      stopVoiceRecording();
    };

    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [voiceState, stopVoiceRecording, sessionId]);

  // Voice input keyboard shortcut: Ctrl+Alt+V (Win/Linux) / Cmd+Option+V (macOS)
  useEffect(() => {
    if (!canUseVoice || !voiceKey) return;

    const unsubscribe = tinykeys(window, {
      [voiceKey]: (e) => {
        e.preventDefault();
        // 멀티패널: 활성 패널 세션만 반응
        const panelState = usePanelStore.getState();
        const tabData = selectActiveTab(panelState);
        const panelActiveSessionId = tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
        if (sessionId !== panelActiveSessionId) return;
        toggleVoiceRecording();
      },
    });
    return unsubscribe;
  }, [canUseVoice, voiceKey, sessionId, toggleVoiceRecording]);
  const handleInputChange = useCallback(
    (value: string) => {
      setInputValue(value);
      setDraftInput(sessionId, value);
      skillPicker.onInputChange(value);
      const cursor = textareaRef.current?.selectionStart ?? value.length;
      filePicker.onInputChange(value, cursor);
      syncAttachmentsWithText(value);
      syncSessionRefsWithText(value);
    },
    [sessionId, setDraftInput, skillPicker, filePicker, syncAttachmentsWithText, syncSessionRefsWithText],
  );

  // --- File drop handlers (OS file explorer → textarea) ---
  const isNativeFileDrag = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes('Files') &&
      !e.dataTransfer.types.includes(SESSION_DRAG_MIME);
  }, []);

  const handleWrapperDragEnter = useCallback((e: React.DragEvent) => {
    handleSessionRefDragEnter(e);
    if (!isNativeFileDrag(e)) return;
    e.preventDefault();
    setFileDragDepth((depth) => depth + 1);
  }, [handleSessionRefDragEnter, isNativeFileDrag]);

  const handleWrapperDragOver = useCallback((e: React.DragEvent) => {
    handleSessionRefDragOver(e);
    if (!isNativeFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [handleSessionRefDragOver, isNativeFileDrag]);

  const handleWrapperDragLeave = useCallback((e: React.DragEvent) => {
    handleSessionRefDragLeave(e);
    if (!isNativeFileDrag(e)) return;
    setFileDragDepth((depth) => Math.max(0, depth - 1));
  }, [handleSessionRefDragLeave, isNativeFileDrag]);

  const handleWrapperDrop = useCallback((e: React.DragEvent) => {
    // Let session ref handler try first
    handleSessionRefDrop(e);

    if (!isNativeFileDrag(e)) return;
    e.preventDefault();

    setFileDragDepth(0);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    void handleFileDrop(files);
  }, [handleFileDrop, handleSessionRefDrop, isNativeFileDrag]);

  const handleSend = () => {
    const trimmed = inputValue.trim();
    const hasSelectedSkill = !!skillPicker.selectedSkill;
    const hasAttachments = attachments.length > 0;
    // Block send only when text, skill, attachments, and refs are all absent, or when disabled
    if (!trimmed && !hasSelectedSkill && !hasAttachments && !hasSessionRefs) return;
    if (isDisabled) return;

    // Use chip-selected skill or fallback to manual /skillname parsing
    const parsed = skillPicker.parseForSend(trimmed);
    const skillName = parsed?.skillName ?? skillPicker.selectedSkill?.name;
    let textContent = parsed ? parsed.content : trimmed;

    // Guard: nothing to send (no content, no skill, no attachments)
    if (!textContent && !skillName && !hasAttachments && !hasSessionRefs) return;

    // Resolve session references: replace [📎 N] with already-resolved export paths
    if (hasSessionRefs) {
      if (!validateSessionRefsReady(textContent)) return;
      textContent = resolveSessionRefs(textContent);
    }

    // Build two versions: send (paths for CLI) and display (filenames for UI)
    const sendContent = buildSendContent(textContent, attachments);
    const displayContent = buildDisplayContent(textContent, attachments);

    if (isReadOnly) return;
    const shouldResumeSession = shouldResumeBeforeSend({
      hasExistingConversation,
      isStopped,
      sessionStatus,
    });

    if (shouldResumeSession && session && 'projectDir' in session) {
      const optimisticMessage = {
        id: `temp-${uuidv4()}`,
        type: 'text' as const,
        role: 'user' as const,
        content: displayContent,
        timestamp: new Date().toISOString(),
      };
      addMessage(sessionId, optimisticMessage);

      addMessage(sessionId, {
        id: `system-resume-${uuidv4()}`,
        type: 'text' as const,
        role: 'system' as const,
        content: t('chat.resumingSession'),
        timestamp: new Date().toISOString(),
      });

      resumeAndSend(sessionId, session.projectDir, sendContent, skillName, displayContent);
    } else {
      // First-time send for a session without a live CLI: attach composer defaults
      // so the server can spawn with the picked model / reasoning / permission mode.
      const needsSpawn = !sessionIsRunning;
      const { settings } = useSettingsStore.getState();
      const providerId = session?.provider?.trim();
      if (!providerId) {
        toast.error(t('errors.providerRequired'));
        return;
      }
      const spawnConfig = needsSpawn
        ? applyProviderSessionRuntimeOverrides(
            getProviderSessionRuntimeConfig(settings, providerId),
            session,
            providerId,
          )
        : undefined;
      sendMessage(sessionId, sendContent, skillName, displayContent, spawnConfig);
    }

    clearInput();
    clearAttachments();
    clearSessionRefs();
    skillPicker.clearSkill();
  };

  const handleInjectCurrentSession = useCallback(async (targetSessionId: string) => {
    const sourceSession = useSessionStore.getState().getSession(sessionId);
    if (!sourceSession) return;

    setIsInjectingCurrentSession(true);
    try {
      const exportPath = await exportSessionReference(sessionId);

      const targetSession = useSessionStore.getState().getSession(targetSessionId);
      const { settings } = useSettingsStore.getState();
      const providerId = targetSession?.provider?.trim();
      if (!providerId) {
        toast.error(t('errors.providerRequired'));
        return;
      }
      const spawnConfig = !(targetSession?.isRunning ?? false)
        ? applyProviderSessionRuntimeOverrides(
            getProviderSessionRuntimeConfig(settings, providerId),
            targetSession,
            providerId,
          )
        : undefined;
      const referenceContent = formatContinueConversationPrompt(exportPath);

      sendMessage(targetSessionId, referenceContent, undefined, referenceContent, spawnConfig);
      setIsQuickCreateOpen(false);
    } catch {
      toast.error(t('errors.sessionExportFailed'));
    } finally {
      setIsInjectingCurrentSession(false);
    }
  }, [sendMessage, sessionId, t]);

  const handleSkillSelect = useCallback(
    (skill: { name: string; description: string }) => {
      skillPicker.selectSkill(skill);
      setInputValue('');
      textareaRef.current?.focus();
    },
    [skillPicker],
  );

  const applyFilePick = useCallback(
    (
      result:
        | { newValue: string; newCursor: number; picked: { kind: 'file' | 'chat' | 'task'; value: string } }
        | null,
    ) => {
      if (!result) return;
      setInputValue(result.newValue);
      setDraftInput(sessionId, result.newValue);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(result.newCursor, result.newCursor);
        // For chat/task picks, add the session reference after the textarea
        // state is updated so the placeholder is inserted at the new cursor.
        if (result.picked.kind !== 'file') {
          addSessionRef(result.picked.value, result.picked.kind);
        }
      });
    },
    [addSessionRef, sessionId, setDraftInput],
  );

  const handleFilePickerSelect = useCallback(
    (index: number) => {
      applyFilePick(filePicker.selectAt(index));
    },
    [applyFilePick, filePicker],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;

    if (skillPicker.isOpen) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        skillPicker.navigateUp();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        skillPicker.navigateDown();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (skillPicker.confirm()) {
          setInputValue('');
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        skillPicker.close();
        return;
      }
    }

    if (filePicker.isOpen) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        filePicker.navigateUp();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        filePicker.navigateDown();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyFilePick(filePicker.confirm());
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        filePicker.close();
        return;
      }
    }

    if (e.key === 'Escape') {
      // 녹음 중지가 최우선
      if (voiceState === 'recording') {
        e.preventDefault();
        stopVoiceRecording();
        return;
      }
      // 활성 인터랙티브 프롬프트(Permission/AskUserQuestion)가 있으면 프롬프트 자체 핸들러에 양보
      const currentPrompt = useChatStore.getState().activeInteractivePrompt.get(sessionId);
      if (currentPrompt) return;
      if (isGenerating) {
        e.preventDefault();
        handleCancel();
        return;
      }
    }

    // ArrowUp/Down: scroll message list when cursor is at edge line, else let default handle
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const ta = textareaRef.current;
      const selStart = ta?.selectionStart ?? 0;
      const firstNewline = inputValue.indexOf('\n');
      const lastNewline = inputValue.lastIndexOf('\n');
      const onEdgeLine =
        firstNewline === -1 ||
        (e.key === 'ArrowUp' ? selStart <= firstNewline : selStart > lastNewline);
      if (onEdgeLine) {
        const container = document.querySelector(`[data-session-messages="${sessionId}"]`);
        if (container) {
          e.preventDefault();
          container.scrollBy({ top: e.key === 'ArrowUp' ? -100 : 100 });
        }
        return;
      }
    }

    // Backspace on empty textarea with a selected skill → remove skill
    if (e.key === 'Backspace' && inputValue === '' && skillPicker.selectedSkill) {
      e.preventDefault();
      skillPicker.clearSkill();
      return;
    }

    if (e.key === 'Enter') {
      // 녹음 중 Enter → 녹음 종료 (전송하지 않음)
      if (voiceState === 'recording') {
        e.preventDefault();
        stopVoiceRecording();
        return;
      }

      if (enterKeyBehavior === 'send') {
        if (!e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      } else {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          handleSend();
        }
      }
    }
  };

  const remainingChars = MAX_CHARS - inputValue.length;
  const isOverLimit = remainingChars < 0;
  const hasContent = inputValue.trim().length > 0 || attachments.length > 0 || hasSessionRefs;
  const canCreateFromCurrentSession = !isInputUnavailable &&
    !activePrompt &&
    hasExistingConversation &&
    !!activeProject &&
    !isInjectingCurrentSession;

  return (
    <div className="pb-2 pt-0">
      <div className={cn('w-full', isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-4')}>
        <MessageRowShell>
          {/* Skill quick access bar (includes its own bottom border) */}
          {!isDisabled && !activePrompt && (
            <SkillQuickAccessBar
              sessionId={sessionId}
              onSelectSkill={handleSkillSelect}
              trailingContent={(
                <>
                  <ComposerSessionControls sessionId={sessionId} variant="inline" />
                  <div ref={quickCreateTriggerRef} className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setIsQuickCreateOpen((open) => !open)}
                      disabled={!canCreateFromCurrentSession}
                      className={cn(
                        'inline-flex h-7 w-7 items-center justify-center rounded-md border text-[11px] transition-colors',
                        'border-(--divider) bg-(--chat-header-bg) text-(--text-secondary)',
                        'hover:border-(--accent)/35 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
                        isQuickCreateOpen && 'border-(--accent)/35 bg-(--sidebar-hover) text-(--text-primary)',
                        !canCreateFromCurrentSession && 'cursor-not-allowed opacity-50 hover:border-(--divider) hover:bg-(--chat-header-bg) hover:text-(--text-secondary)',
                      )}
                      title={t('task.creation.continueButtonTooltip')}
                      aria-label={t('task.creation.continueButtonTooltip')}
                      aria-expanded={isQuickCreateOpen}
                      aria-haspopup="dialog"
                      data-testid="composer-context-quick-create-trigger"
                    >
                      <MessageSquareShare className="h-3.5 w-3.5" />
                    </button>

                    {isQuickCreateOpen && activeProject && (
                      <CollectionQuickCreateSheet
                        collection={activeCollection}
                        collections={collections}
                        projectDir={activeProject.decodedPath}
                        projectId={activeProject.encodedDir}
                        allowCollectionSelection
                        anchorRef={quickCreateTriggerRef}
                        boundaryRef={quickCreateTriggerRef}
                        anchorPlacement="top"
                        scopeId={`composer-${sessionId}`}
                        continuationSourceTitle={session?.title ?? sessionId.slice(0, 8)}
                        onSessionCreated={handleInjectCurrentSession}
                        onClose={() => setIsQuickCreateOpen(false)}
                      />
                    )}
                  </div>
                  <PanelSplitPicker sessionId={sessionId} compact />
                </>
              )}
            />
          )}

          {/* Separator — only when skill bar is hidden */}
          {(isDisabled || activePrompt) && <Separator />}

          <div
            data-session-ref-drop
            onDragEnter={handleWrapperDragEnter}
            onDragOver={handleWrapperDragOver}
            onDragLeave={handleWrapperDragLeave}
            onDrop={handleWrapperDrop}
            className={cn(
              'relative rounded-lg border transition-colors',
              'bg-(--input-bg) border-(--input-border)',
              isInputUnavailable && 'opacity-50',
              !isInputUnavailable && !isVoiceActive && 'focus-within:border-(--accent)/50',
              voiceState === 'recording' && 'border-(--error) animate-pulse',
              (isSessionRefDragOver || isFileDragOver) && 'border-(--accent) ring-2 ring-(--accent)/30 ring-inset',
            )}
          >
          {/* Skill picker popup */}
          <SkillPicker
            isOpen={skillPicker.isOpen}
            isLoading={skillPicker.isLoading}
            isInactive={skillPicker.isInactive}
            skills={skillPicker.filteredSkills}
            selectedIndex={skillPicker.selectedIndex}
            onSelect={handleSkillSelect}
            onClose={skillPicker.close}
          />

          {/* @-mention reference picker popup */}
          <FilePicker
            isOpen={filePicker.isOpen}
            isLoading={filePicker.isLoading}
            results={filePicker.results}
            sectionBoundaries={filePicker.sectionBoundaries}
            selectedIndex={filePicker.selectedIndex}
            onSelect={handleFilePickerSelect}
            onClose={filePicker.close}
          />

          {isSessionRefDragOver && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--input-bg)_78%,var(--accent)_22%)] backdrop-blur-[1px]">
              <div className="flex items-center gap-2 rounded-full border border-(--accent)/35 bg-(--input-bg) px-3 py-1.5 text-xs font-medium text-(--accent) shadow-lg shadow-black/10">
                <MessageSquarePlus className="h-3.5 w-3.5" />
                <span>{t('chat.dropSessionReference')}</span>
              </div>
            </div>
          )}

        <MessageInputAttachmentStrip
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          renderAttachmentAlt={(id) => t('validation.attachmentAlt', { id })}
          renderRemoveLabel={(id) => t('validation.removeImage', { id })}
        />

        <MessageInputSessionRefStrip
          refs={sessionRefItems}
          onRemoveRef={removeSessionRef}
          onRetryRef={retrySessionRef}
        />

        {isWebSpeechActive && (
          <MessageInputWebSpeechBar
            elapsedTime={voiceElapsedTime}
            onStop={stopVoiceRecording}
            recordingLabel={t('voice.recording')}
            stopLabel={t('voice.stop')}
          />
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          tabIndex={-1}
        />

        {/* Textarea row with controls */}
        <div className="flex items-center gap-2">
        {/* Attachment button */}
        {!isVoiceActive && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isInputUnavailable || !!activePrompt}
            className={cn(
              'shrink-0 rounded-md p-2 transition-all duration-150',
              isInputUnavailable || activePrompt
                ? 'text-(--text-muted) cursor-not-allowed opacity-50'
                : 'text-(--text-muted) hover:text-(--accent) hover:bg-(--accent)/10',
            )}
            aria-label={t('chat.attachFile')}
            title={t('chat.attachFileHint')}
          >
            <Paperclip className="w-4 h-4" />
          </button>
        )}

        {/* Gemini: full overlay replaces textarea / Web Speech & idle: show textarea */}
        {isVoiceActive && sttEngine === 'gemini' ? (
          <VoiceRecordingOverlay
            state={voiceState}
            elapsedTime={voiceElapsedTime}
            volumeLevel={voiceVolumeLevel}
            onStop={stopVoiceRecording}
          />
        ) : (
          <div className="flex-1 flex items-center min-h-[2.75rem]">
            {/* Skill chip */}
            {skillPicker.selectedSkill && (
              <MessageInputSkillChip
                skillName={skillPicker.selectedSkill.name}
                removeTooltip={t('skill.removeTooltip')}
                onRemove={() => {
                  skillPicker.clearSkill();
                  textareaRef.current?.focus();
                }}
              />
            )}

            <textarea
              ref={textareaRef}
              data-session-input={sessionId}
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onSelect={(e) => {
                const el = e.currentTarget;
                filePicker.onInputChange(el.value, el.selectionStart);
              }}
              onPaste={handlePaste}
              placeholder={
                isWebSpeechActive
                  ? t('voice.placeholder')
                  : isReadOnly
                    ? t('chat.readOnlyPlaceholder')
                      : isDisabled
                        ? t('errors.sessionDisconnected')
                      : activePrompt?.promptType === 'permission_request'
                        ? t('prompts.permissionWaiting')
                        : activePrompt?.promptType === 'plan_approval'
                          ? t('prompts.planApprovalWaiting')
                          : activePrompt?.promptType === 'ask_user_question'
                          ? t('prompts.questionWaiting')
                          : activePrompt
                            ? t('prompts.responseWaiting')
                            : isGenerating
                              ? t('chat.cancelHint')
                              : skillPicker.selectedSkill
                                ? t('chat.messagePlaceholder')
                                : enterKeyBehavior === 'newline'
                                  ? t('chat.inputNewlineMode')
                                  : t('chat.inputSendMode')
              }
              disabled={isInputUnavailable || !!activePrompt}
              readOnly={isWebSpeechActive && voicePendingInterim !== ''}
              className={cn(
                'flex-1 px-3 py-3 bg-transparent text-sm text-(--input-text) resize-none overflow-y-auto',
                'placeholder:text-(--input-placeholder) placeholder:whitespace-nowrap placeholder:overflow-hidden placeholder:text-ellipsis',
                'focus:outline-none',
                'disabled:cursor-not-allowed',
                isOverLimit && 'text-(--error)',
                isWebSpeechActive && voicePendingInterim !== '' && 'opacity-70',
              )}
              rows={1}
            />
          </div>
        )}

        {/* Right side controls */}
        <div className="flex items-center gap-1 pr-2">
          {!isVoiceActive && remainingChars < 1000 && (
            <span className={cn(
              'text-xs px-1',
              isOverLimit ? 'text-(--error)' : 'text-(--text-muted)'
            )}>
              {remainingChars}
            </span>
          )}

          {/* Mic button (hidden during voice active or generating) */}
          {showVoiceInput && !isVoiceActive && !isGenerating && (
            <ShortcutTooltip id="voice-input" label={t('shortcut.voiceInput')}>
              <button
                onClick={toggleVoiceRecording}
                disabled={!canUseVoice}
                className={cn(
                  'p-2 rounded-md transition-all duration-150',
                  canUseVoice
                    ? 'text-(--text-muted) hover:text-(--accent) hover:bg-(--accent)/10'
                    : 'text-(--text-muted) cursor-not-allowed opacity-50',
                )}
                aria-label={t('voice.input')}
              >
                <Mic className="w-4 h-4" />
              </button>
            </ShortcutTooltip>
          )}

          {isGenerating && !activePrompt ? (
            <button
              onClick={handleCancel}
              data-testid="cancel-generation-btn"
              className="p-2 rounded-md transition-all duration-150 bg-(--error) text-white hover:bg-(--destructive-hover) scale-100"
              title={t('chat.cancelButton')}
            >
              <Square className="w-4 h-4 fill-current" />
            </button>
          ) : !isVoiceActive ? (
            <button
              onClick={handleSend}
              disabled={isInputUnavailable || (!hasContent && !skillPicker.selectedSkill) || isOverLimit}
              className={cn(
                'p-2 rounded-md transition-all duration-150',
                hasContent && !isInputUnavailable && !isOverLimit
                  ? 'bg-(--accent) text-white hover:bg-(--accent-hover) scale-100'
                  : 'text-(--text-muted) cursor-not-allowed scale-95'
              )}
            >
              <SendHorizontal className="w-4.5 h-4.5" />
            </button>
          ) : null}
        </div>
        </div>{/* end flex items-end row */}
        </div>

        <ContextStatusBar sessionId={sessionId} isReadOnly={isReadOnly} />
        </MessageRowShell>
      </div>
    </div>
  );
}
