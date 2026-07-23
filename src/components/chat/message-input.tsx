'use client';

import {
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
  type SetStateAction,
} from 'react';
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
import { useSessionCrud } from '@/hooks/use-session-crud';
import { useSkillPicker, type SkillInfo } from '@/hooks/use-skill-picker';
import { SkillPicker } from '@/components/chat/skill-picker';
import { useFilePicker } from '@/hooks/use-file-picker';
import { FilePicker } from '@/components/chat/file-picker';
import { Separator } from '@/components/ui/separator';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useTaskStore } from '@/stores/task-store';
import { shouldRouteToTerminalFallback } from '@/lib/terminal/tui-only-commands';
import {
  setPendingTerminalLaunch,
  takePendingTerminalLaunch,
} from '@/lib/terminal/pending-terminal-launch';
import {
  consumeTerminalLaunchResult,
  takeTerminalLaunchResultsForSession,
  TERMINAL_LAUNCH_RESULT_EVENT,
  type TerminalLaunchResultDetail,
} from '@/lib/terminal/terminal-launch-result';
import {
  clearClientTerminalHandoff,
  hasClientTerminalHandoff,
  markClientTerminalHandoff,
} from '@/lib/terminal/client-terminal-handoff-state';
import {
  consumeTerminalLaunchDraft,
  recordTerminalDraftEdit,
  registerTerminalLaunchDraft,
  shouldClearTerminalLaunchDraft,
} from '@/lib/terminal/terminal-launch-draft-state';
import {
  getSessionTerminalId,
  sendInputToTerminal,
} from '@/lib/terminal/terminal-surface-registry';
import { useSettingsStore } from '@/stores/settings-store';
import { useGitStore } from '@/stores/git-store';
import { matchShortcut, formatShortcut } from '@/lib/keyboard-shortcut';
import {
  applyProviderSessionRuntimeOverrides,
  buildProviderSessionDefaultsUpdate,
  getProviderSessionDefaultsWithOptions,
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
import {
  getWorkspaceFileDragPath,
  hasWorkspaceFileDragData,
} from '@/lib/dnd/panel-session-drag';
import { PanelSplitPicker } from './panel-split-picker';
import { ComposerSessionControls } from './composer-session-controls';
import { DeleteSessionDialog } from './delete-session-dialog';
import { useEffectiveShortcut } from '@/hooks/use-effective-shortcut';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { exportSessionReference, formatContinueConversationPrompt } from '@/lib/session/session-reference';
import { CollectionQuickCreateSheet } from './collection-quick-create-sheet';
import type { Collection } from '@/types/collection';
import { insertWorkspaceFileReferenceAtCursor } from '@/lib/chat/workspace-file-reference';
import {
  CODEX_DEFAULT_SERVICE_TIER,
  CODEX_FAST_COMMAND,
  getCodexFastServiceTier,
  getCodexFastToggleServiceTier,
  isCodexFastCommandSkill,
} from '@/lib/chat/codex-fast-command';
import {
  CODEX_COMPACT_COMMAND,
  isCodexCompactCommandSkill,
} from '@/lib/chat/codex-compact-command';
import {
  isClaudeFastCommandSkill,
} from '@/lib/chat/claude-fast-command';
import {
  classifyCodexSlashCommand,
  isCodexSlashCommandAvailable,
  isReservedCodexSlashCommandName,
} from '@/lib/chat/codex-slash-command-registry';
import { dispatchCodexNativeUiAction } from '@/lib/chat/codex-native-command-events';
import {
  MessageInputAttachmentStrip,
  MessageInputSessionRefStrip,
  MessageInputSkillChip,
  MessageInputWebSpeechBar,
} from './message-input-sections';
import type { SessionSpawnConfig } from '@/lib/ws/message-types';

interface MessageInputProps {
  sessionId: string;
  isDisabled: boolean;
  isReadOnly?: boolean;
  isStopped?: boolean;
  isSinglePanel?: boolean;
  surfaceActive?: boolean;
}

const EMPTY_COLLECTIONS: Collection[] = [];

export function MessageInput({
  sessionId,
  isDisabled,
  isReadOnly,
  isStopped,
  isSinglePanel = false,
  surfaceActive = false,
}: MessageInputProps) {
  const { t } = useI18n();
  const setDraftInput = useChatStore((state) => state.setDraftInput);
  const [inputValue, setInputValue] = useState(() => useChatStore.getState().getDraftInput(sessionId));
  const [deleteRequested, setDeleteRequested] = useState(false);
  // Attachment/reference/voice completion can update the local composer after a
  // terminal launch but before its prefill ACK. Record that intent synchronously
  // (before React commits the state update) so an older ACK cannot clear it.
  const setInputValueFromProgrammaticEdit = useCallback((value: SetStateAction<string>) => {
    recordTerminalDraftEdit(sessionId);
    setInputValue(value);
  }, [sessionId]);
  const clearInput = useCallback(() => {
    setInputValue('');
    setDraftInput(sessionId, '');
  }, [sessionId, setDraftInput]);

  useEffect(() => {
    const applyTerminalLaunchResult = (detail: TerminalLaunchResultDetail) => {
      if (!detail || detail.sourceSessionId !== sessionId) return;
      const pendingDraft = consumeTerminalLaunchDraft(detail.terminalId);
      if (detail.status === 'error') {
        toast.error(detail.message ?? t('chat.codexSlashTerminalOpenFailed'));
        return;
      }

      const draft = useChatStore.getState().getDraftInput(sessionId);
      if (
        pendingDraft
        && shouldClearTerminalLaunchDraft(pendingDraft, draft)
      ) {
        setInputValue('');
        setDraftInput(sessionId, '');
      }
      toast.info(t('chat.slashTerminalFallback', { command: detail.commandInput }));
    };
    const handleTerminalLaunchResult = (event: Event) => {
      const detail = (event as CustomEvent<TerminalLaunchResultDetail>).detail;
      if (!detail || detail.sourceSessionId !== sessionId) return;
      consumeTerminalLaunchResult(detail.terminalId);
      applyTerminalLaunchResult(detail);
    };
    window.addEventListener(TERMINAL_LAUNCH_RESULT_EVENT, handleTerminalLaunchResult);
    for (const detail of takeTerminalLaunchResultsForSession(sessionId)) {
      applyTerminalLaunchResult(detail);
    }
    return () => window.removeEventListener(TERMINAL_LAUNCH_RESULT_EVENT, handleTerminalLaunchResult);
  }, [sessionId, setDraftInput, t]);

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
  const updateSessionRuntimeConfig = useSessionStore((state) => state.updateSessionRuntimeConfig);
  const projects = useSessionStore((state) => state.projects);
  const sessionStatus = session && 'status' in session ? session.status : 'running';
  const sessionProviderId = session?.provider?.trim() ?? '';
  const sessionCollectionId = session?.collectionId ?? null;
  const sessionServiceTier = session?.serviceTier;
  const sessionFastMode = session?.fastMode;
  const {
    sendMessage,
    cancelGeneration,
    compactSession,
    setServiceTier,
    setFastMode,
  } = useWebSocket();
  const { resumeAndSend, isResuming } = useSessionResume();
  const { createSession, deleteSession, forkSession, renameSession } = useSessionCrud();
  const enterKeyBehavior = useSettingsStore(
    (state) => state.settings.enterKeyBehavior ?? 'send'
  );
  const translateSendShortcut = useSettingsStore(
    (state) => state.settings.translate?.sendShortcut || 'meta+enter'
  );
  const fontSize = useSettingsStore((state) => state.settings.fontSize);
  const sttEngine = useSettingsStore((state) => state.settings.sttEngine);
  const settings = useSettingsStore((state) => state.settings);
  const serverPlatform = useSettingsStore((state) => state.serverHostInfo?.platform ?? null);
  const agentEnvironment = settings.agentEnvironment;
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const isElectron = useElectronPlatform() !== null;

  const sessionIsRunning = session?.isRunning ?? false;
  const providerSessionOptions = useProviderSessionOptions(
    sessionProviderId || undefined,
    agentEnvironment,
  );
  const providerDefaultsWithOptions = getProviderSessionDefaultsWithOptions(
    settings,
    sessionProviderId,
    providerSessionOptions.data,
  );
  const selectedModel = session?.model ?? providerDefaultsWithOptions.model;
  const selectedModelOption = providerSessionOptions.data?.modelOptions
    .find((option) => option.value === selectedModel) ?? null;
  const codexFastTier = getCodexFastServiceTier(selectedModelOption);
  const skillPicker = useSkillPicker(
    sessionId,
    sessionProviderId || undefined,
    sessionIsRunning,
    sessionProviderId !== 'codex' || codexFastTier !== null,
    serverPlatform,
    agentEnvironment,
  );
  const filePicker = useFilePicker(sessionId);
  const getInputValue = useCallback(() => inputValue, [inputValue]);
  const sessionRefs = useSessionRefs({
    textareaRef,
    setInputValue: setInputValueFromProgrammaticEdit,
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
    setInputValue: setInputValueFromProgrammaticEdit,
    t,
  });
  const MAX_CHARS = 10000;
  const MAX_ROWS = 5;

  const isInputUnavailable = isReadOnly || isDisabled || isResuming;
  const isGenerating = sessionStatus === 'running' && (
    isTurnInFlight || hasActiveAssistantText
  );
  const buildSpawnConfigForCurrentSession = useCallback((): SessionSpawnConfig | undefined => {
    if (sessionIsRunning) return undefined;

    const providerId = sessionProviderId;
    if (!providerId) return undefined;

    const { settings } = useSettingsStore.getState();
    return applyProviderSessionRuntimeOverrides(
      getProviderSessionRuntimeConfig(settings, providerId),
      session,
      providerId,
    );
  }, [session, sessionIsRunning, sessionProviderId]);
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
    if (!sessionCollectionId) return null;
    return collections.find((collection) => collection.id === sessionCollectionId) ?? null;
  }, [collections, sessionCollectionId]);

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
      setInputValueFromProgrammaticEdit(newValue);
      requestAnimationFrame(() => {
        const newPos = cursorPos + separator.length + text.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
      });
    } else {
      setInputValueFromProgrammaticEdit((prev) => (prev ? prev + ' ' + text : text));
    }
  }, [setInputValueFromProgrammaticEdit]);

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
      setInputValueFromProgrammaticEdit(base);
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
    if (surfaceActive) {
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const ps = usePanelStore.getState();
    const tabData = selectActiveTab(ps);
    const activePanelId = tabData?.activePanelId ?? '';
    const panels = tabData?.panels ?? {};
    if (panels[activePanelId]?.sessionId === sessionId) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [sessionId, surfaceActive]);

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
      if (!surfaceActive) {
        const panelState = usePanelStore.getState();
        const tabData = selectActiveTab(panelState);
        const panelActiveSessionId = tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
        if (sessionId !== panelActiveSessionId) return;
      }

      e.preventDefault();
      stopVoiceRecording();
    };

    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [voiceState, stopVoiceRecording, sessionId, surfaceActive]);

  // Voice input keyboard shortcut: Ctrl+Alt+V (Win/Linux) / Cmd+Option+V (macOS)
  useEffect(() => {
    if (!canUseVoice || !voiceKey) return;

    const unsubscribe = tinykeys(window, {
      [voiceKey]: (e) => {
        e.preventDefault();
        // 멀티패널: 활성 패널 세션만 반응
        if (!surfaceActive) {
          const panelState = usePanelStore.getState();
          const tabData = selectActiveTab(panelState);
          const panelActiveSessionId = tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
          if (sessionId !== panelActiveSessionId) return;
        }
        toggleVoiceRecording();
      },
    });
    return unsubscribe;
  }, [canUseVoice, voiceKey, sessionId, surfaceActive, toggleVoiceRecording]);
  const handleInputChange = useCallback(
    (value: string) => {
      recordTerminalDraftEdit(sessionId);
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

  const isWorkspaceFileDrag = useCallback((e: React.DragEvent) => {
    return hasWorkspaceFileDragData(e.dataTransfer);
  }, []);

  const insertWorkspaceFileReference = useCallback((filePath: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setInputValueFromProgrammaticEdit((prev) => {
        const { nextValue } = insertWorkspaceFileReferenceAtCursor(prev, prev.length, filePath);
        setDraftInput(sessionId, nextValue);
        return nextValue;
      });
      filePicker.close();
      return;
    }

    const cursorPos = textarea.selectionStart;
    const currentValue = textarea.value;
    const { nextCursorPos, nextValue } = insertWorkspaceFileReferenceAtCursor(
      currentValue,
      cursorPos,
      filePath,
    );

    setInputValueFromProgrammaticEdit(nextValue);
    setDraftInput(sessionId, nextValue);
    filePicker.close();
    requestAnimationFrame(() => {
      textarea.setSelectionRange(nextCursorPos, nextCursorPos);
      textarea.focus();
    });
  }, [filePicker, sessionId, setDraftInput, setInputValueFromProgrammaticEdit]);

  const handleWrapperDragEnter = useCallback((e: React.DragEvent) => {
    if (isWorkspaceFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      setFileDragDepth((depth) => depth + 1);
      return;
    }
    handleSessionRefDragEnter(e);
    if (!isNativeFileDrag(e)) return;
    e.preventDefault();
    setFileDragDepth((depth) => depth + 1);
  }, [handleSessionRefDragEnter, isNativeFileDrag, isWorkspaceFileDrag]);

  const handleWrapperDragOver = useCallback((e: React.DragEvent) => {
    if (isWorkspaceFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    handleSessionRefDragOver(e);
    if (!isNativeFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [handleSessionRefDragOver, isNativeFileDrag, isWorkspaceFileDrag]);

  const handleWrapperDragLeave = useCallback((e: React.DragEvent) => {
    if (isWorkspaceFileDrag(e)) {
      e.stopPropagation();
      setFileDragDepth((depth) => Math.max(0, depth - 1));
      return;
    }
    handleSessionRefDragLeave(e);
    if (!isNativeFileDrag(e)) return;
    setFileDragDepth((depth) => Math.max(0, depth - 1));
  }, [handleSessionRefDragLeave, isNativeFileDrag, isWorkspaceFileDrag]);

  const handleWrapperDrop = useCallback((e: React.DragEvent) => {
    if (isWorkspaceFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      setFileDragDepth(0);
      const filePath = getWorkspaceFileDragPath(e.dataTransfer);
      if (filePath) {
        insertWorkspaceFileReference(filePath);
      }
      return;
    }

    // Let session ref handler try first
    handleSessionRefDrop(e);

    if (!isNativeFileDrag(e)) return;
    e.preventDefault();

    setFileDragDepth(0);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    void handleFileDrop(files);
  }, [
    handleFileDrop,
    handleSessionRefDrop,
    insertWorkspaceFileReference,
    isNativeFileDrag,
    isWorkspaceFileDrag,
  ]);

  const executeCodexFastCommand = useCallback((): boolean => {
    if (sessionProviderId !== 'codex') {
      return false;
    }

    const nextServiceTier = getCodexFastToggleServiceTier(
      sessionServiceTier,
      selectedModelOption,
    );
    if (!codexFastTier || !nextServiceTier) {
      toast.info(t('chat.codexFastUnavailable'));
      return true;
    }

    if (!sessionIsRunning) {
      void updateSettings(buildProviderSessionDefaultsUpdate(
        useSettingsStore.getState().settings,
        'codex',
        { serviceTier: nextServiceTier },
      ));
    }
    updateSessionRuntimeConfig(sessionId, { serviceTier: nextServiceTier });
    setServiceTier(sessionId, nextServiceTier);
    clearInput();
    clearAttachments();
    clearSessionRefs();
    skillPicker.clearSkill();
    toast.info(
      nextServiceTier === CODEX_DEFAULT_SERVICE_TIER
        ? t('chat.codexFastDisabled')
        : t('chat.codexFastEnabled'),
    );
    return true;
  }, [
    clearAttachments,
    clearInput,
    clearSessionRefs,
    codexFastTier,
    selectedModelOption,
    sessionProviderId,
    sessionServiceTier,
    sessionId,
    sessionIsRunning,
    setServiceTier,
    skillPicker,
    t,
    updateSettings,
    updateSessionRuntimeConfig,
  ]);

  const executeCodexCompactCommand = useCallback((): boolean => {
    if (sessionProviderId !== 'codex') {
      return false;
    }
    if (isDisabled || isReadOnly) {
      return false;
    }
    if (isGenerating) {
      toast.info(t('chat.codexCompactDuringTurn'));
      return true;
    }

    const displayContent = CODEX_COMPACT_COMMAND;
    addMessage(sessionId, {
      id: `temp-compact-${uuidv4()}`,
      type: 'text',
      role: 'user',
      content: displayContent,
      timestamp: new Date().toISOString(),
    });
    compactSession(sessionId, buildSpawnConfigForCurrentSession(), displayContent);
    clearInput();
    clearAttachments();
    clearSessionRefs();
    skillPicker.clearSkill();
    return true;
  }, [
    addMessage,
    buildSpawnConfigForCurrentSession,
    clearAttachments,
    clearInput,
    clearSessionRefs,
    compactSession,
    isDisabled,
    isGenerating,
    isReadOnly,
    sessionProviderId,
    sessionId,
    skillPicker,
    t,
  ]);

  const executeClaudeFastCommand = useCallback((): boolean => {
    if (sessionProviderId !== 'claude-code') {
      return false;
    }

    const next = !(sessionFastMode === true);
    updateSessionRuntimeConfig(sessionId, { fastMode: next });
    if (sessionIsRunning) {
      setFastMode(sessionId, next);
    }
    clearInput();
    clearAttachments();
    clearSessionRefs();
    skillPicker.clearSkill();
    toast.info(
      next
        ? 'Claude fast mode enabled'
        : 'Claude fast mode disabled',
    );
    return true;
  }, [
    clearAttachments,
    clearInput,
    clearSessionRefs,
    sessionProviderId,
    sessionFastMode,
    sessionId,
    sessionIsRunning,
    setFastMode,
    skillPicker,
    updateSessionRuntimeConfig,
  ]);

  const openTerminalFallback = useCallback((
    command: string,
    provider: 'claude-code' | 'codex' = sessionProviderId === 'codex' ? 'codex' : 'claude-code',
    locksSourceSession = false,
  ): boolean => {
    const panelStore = usePanelStore.getState();
    const activeTab = selectActiveTab(panelStore);
    const activePanelId = activeTab?.activePanelId;
    const activePanel = activePanelId ? activeTab?.panels[activePanelId] : undefined;
    if (!activePanelId || !activePanel) return false;
    const terminalId = uuidv4();
    registerTerminalLaunchDraft(
      terminalId,
      sessionId,
      useChatStore.getState().getDraftInput(sessionId),
    );
    setPendingTerminalLaunch(terminalId, {
      intent: {
        kind: provider === 'codex' ? 'codex-slash' : 'claude-slash',
        commandInput: command,
      },
      sourceSessionId: sessionId,
      locksSourceSession,
    });
    if (locksSourceSession) {
      markClientTerminalHandoff(terminalId, sessionId);
    }
    let newPanelId: string | null;
    if (activePanel.sessionId === null && !activePanel.terminalId) {
      // Reuse a terminal panel that the user just closed, but keep the command
      // tied to this composer instead of inheriting the empty panel's null session.
      panelStore.assignTerminal(activePanelId, terminalId, sessionId);
      newPanelId = activePanelId;
    } else {
      // The terminal panel becomes active after launch. If another slash command
      // is entered from the still-visible composer, split from its session panel
      // so the server always receives the correct session id.
      const sourcePanelId = Object.values(activeTab.panels)
        .find((panel) => panel.sessionId === sessionId)?.id ?? activePanelId;
      newPanelId = panelStore.createTerminalPanel(sourcePanelId, terminalId, 'vertical');
    }
    if (!newPanelId) {
      takePendingTerminalLaunch(terminalId);
      consumeTerminalLaunchDraft(terminalId);
      clearClientTerminalHandoff(terminalId);
      return false;
    }
    if (provider === 'claude-code') {
      setInputValue('');
      setDraftInput(sessionId, '');
    }
    skillPicker.close();
    // confirm()이 terminalFallback 항목을 selectedSkill로 세팅했을 수 있으므로 정리한다.
    // 안 하면 다음 전송에서 그 명령 이름이 실제 스킬로 잘못 전송된다.
    skillPicker.clearSkill();
    return true;
  }, [sessionId, sessionProviderId, setDraftInput, skillPicker]);

  const dispatchCodexSlashCommand = useCallback((
    commandInput: string,
    _source: 'send' | 'picker' = 'send',
  ): boolean => {
    if (sessionProviderId !== 'codex') return false;

    const match = classifyCodexSlashCommand(commandInput);
    if (!match) return false;
    if (!isCodexSlashCommandAvailable(match.canonicalName, {
      platform: serverPlatform,
      agentEnvironment,
    })) {
      toast.info(t('chat.codexSlashPlatformUnavailable', { command: `/${match.name}` }));
      return true;
    }
    if (match.support === 'hidden') {
      toast.info(t('chat.codexSlashUnsupported', { command: `/${match.name}` }));
      return true;
    }
    if (match.support.startsWith('terminal-')) {
      if (match.args && match.terminalMode === 'resume-picker') {
        toast.info(t('chat.codexSlashUnsupported', { command: commandInput }));
        return true;
      }
      const locksSourceSession = match.support === 'terminal-handoff';
      if (locksSourceSession
        && (isGenerating || activePrompt || hasClientTerminalHandoff(sessionId))) {
        toast.info(t('chat.codexSlashTerminalBusy', { command: `/${match.name}` }));
        return true;
      }
      if (!openTerminalFallback(commandInput, 'codex', locksSourceSession)) {
        toast.error(t('chat.codexSlashTerminalOpenFailed'));
      }
      // Official commands never fall through into a normal Codex turn, even
      // when the local panel could not be created.
      return true;
    }

    if (match.nativeCommand === 'fast') {
      if (match.args) {
        toast.info(t('chat.codexSlashUnsupported', { command: `/${match.name}` }));
        return true;
      }
      return executeCodexFastCommand();
    }
    if (match.nativeCommand === 'compact') {
      if (match.args) {
        toast.info(t('chat.codexSlashUnsupported', { command: `/${match.name}` }));
        return true;
      }
      return executeCodexCompactCommand();
    }
    if (match.nativeCommand === 'fork') {
      if (match.args) {
        toast.info(t('chat.codexSlashUnsupported', { command: commandInput }));
        return true;
      }
      if (
        isGenerating
        || activePrompt
        || hasClientTerminalHandoff(sessionId)
      ) {
        toast.info(t('chat.codexSlashTerminalBusy', { command: `/${match.name}` }));
        return true;
      }
      void forkSession(sessionId).then((forkedSessionId) => {
        if (!forkedSessionId) return;
        if (useChatStore.getState().getDraftInput(sessionId).trim() === commandInput.trim()) {
          clearInput();
        }
        skillPicker.close();
        skillPicker.clearSkill();
      });
      return true;
    }
    if (match.nativeCommand === 'delete') {
      if (match.args) {
        toast.info(t('chat.codexSlashUnsupported', { command: commandInput }));
        return true;
      }
      setDeleteRequested(true);
      skillPicker.close();
      skillPicker.clearSkill();
      return true;
    }

    if (match.nativeCommand === 'model' || match.nativeCommand === 'permissions') {
      dispatchCodexNativeUiAction(sessionId, match.nativeCommand);
      clearInput();
      skillPicker.close();
      skillPicker.clearSkill();
      return true;
    } else if (match.nativeCommand === 'plan') {
      dispatchCodexNativeUiAction(sessionId, 'plan');
      if (match.args) {
        setInputValueFromProgrammaticEdit(match.args);
        setDraftInput(sessionId, match.args);
      } else {
        clearInput();
      }
    } else if (match.nativeCommand === 'skills') {
      setInputValueFromProgrammaticEdit('/');
      setDraftInput(sessionId, '/');
      skillPicker.openSkillsOnly();
      requestAnimationFrame(() => textareaRef.current?.focus());
      return true;
    } else if (match.nativeCommand === 'mention') {
      setInputValueFromProgrammaticEdit('@');
      setDraftInput(sessionId, '@');
      filePicker.onInputChange('@', 1);
    } else if (match.nativeCommand === 'diff') {
      useGitStore.getState().open();
      clearInput();
    } else if (match.nativeCommand === 'copy') {
      const latest = [...(useChatStore.getState().messages.get(sessionId) ?? [])]
        .reverse()
        .find((message) => message.type === 'text' && message.role === 'assistant');
      const text = latest?.type === 'text'
        ? typeof latest.content === 'string'
          ? latest.content
          : latest.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
        : '';
      if (text && navigator.clipboard) {
        void navigator.clipboard.writeText(text)
          .then(() => toast.success(t('chat.codexSlashCopied')))
          .catch(() => toast.error(t('chat.codexSlashCopyFailed')));
      } else {
        toast.info(t('chat.codexSlashNothingToCopy'));
      }
      clearInput();
    } else if (match.nativeCommand === 'status') {
      toast.info(t('chat.codexSlashStatus', {
        model: session?.model ?? selectedModel ?? '-',
        status: session?.status ?? '-',
        cwd: session?.workDir ?? '-',
      }));
      clearInput();
    } else if (match.nativeCommand === 'rename') {
      if (match.args) void renameSession(sessionId, match.args);
      else {
        clearInput();
        skillPicker.close();
        skillPicker.clearSkill();
        dispatchCodexNativeUiAction(sessionId, 'rename');
        return true;
      }
      clearInput();
    } else if (match.nativeCommand === 'archive') {
      if (session?.taskId) {
        void useTaskStore.getState().toggleTaskArchive(session.taskId, true);
      } else {
        useSessionStore.getState().toggleArchive(sessionId, true);
      }
      clearInput();
    } else if (match.nativeCommand === 'new' || match.nativeCommand === 'clear') {
      void createSession({
        providerId: 'codex',
        workDir: session?.workDir,
        parentProjectId: session?.projectDir,
        collectionId: session?.collectionId ?? undefined,
      });
      clearInput();
    } else {
      return false;
    }

    skillPicker.close();
    skillPicker.clearSkill();
    requestAnimationFrame(() => textareaRef.current?.focus());
    return true;
  }, [
    activePrompt,
    agentEnvironment,
    clearInput,
    createSession,
    forkSession,
    executeCodexCompactCommand,
    executeCodexFastCommand,
    filePicker,
    isGenerating,
    openTerminalFallback,
    renameSession,
    selectedModel,
    serverPlatform,
    session,
    sessionId,
    sessionProviderId,
    setDraftInput,
    setInputValueFromProgrammaticEdit,
    skillPicker,
    t,
  ]);

  // terminal-mode(session.kind==='terminal') claude 세션의 전송: 같은 세션 cwd로 터미널을
  // 분할해 PTY claude를 서버 조립 argv로 띄우고, 입력한 프롬프트를 프리필한다(자동 실행 X).
  // 서버가 --settings hooks / --session-id 를 조립하므로 클라는 launch 스펙만 넘긴다.
  // terminal-mode 세션의 전송: 같은 세션 cwd로 터미널 분할, PTY를 서버 조립 argv로 띄우고
  // 프롬프트 프리필(자동 실행 X). 세션당 1 PTY 재사용은 provider 무관 동일.
  const launchProviderPty = useCallback((providerId: string, prefill: string): boolean => {
    const panelStore = usePanelStore.getState();
    const terminalId = getSessionTerminalId(sessionId);
    if (sendInputToTerminal(terminalId, prefill.replace(/[\r\n\t]+/g, ' '))) {
      return true;
    }
    const activePanelId = selectActiveTab(panelStore)?.activePanelId;
    if (!activePanelId) return false;
    setPendingTerminalLaunch(terminalId, {
      launch: { providerId, sessionId },
      prefillInput: prefill,
    });
    const newPanelId = panelStore.createTerminalPanel(activePanelId, terminalId, 'vertical');
    if (!newPanelId) {
      takePendingTerminalLaunch(terminalId);
      return false;
    }
    return true;
  }, [sessionId]);

  const handleSend = (sendOptions?: { forceTranslate?: boolean }) => {
    const forceTranslateInput = sendOptions?.forceTranslate === true;
    const trimmed = inputValue.trim();
    const hasSelectedSkill = !!skillPicker.selectedSkill;
    const hasSelectedFastCommand = isCodexFastCommandSkill(skillPicker.selectedSkill)
      || isClaudeFastCommandSkill(skillPicker.selectedSkill);
    const hasSelectedCompactCommand = isCodexCompactCommandSkill(skillPicker.selectedSkill);
    const hasAttachments = attachments.length > 0;

    // Block send only when text, skill, attachments, and refs are all absent, or when disabled
    if (!trimmed && !hasSelectedSkill && !hasAttachments && !hasSessionRefs) return;
    if (isDisabled) return;
    if (isReadOnly) return;

    if (sessionProviderId === 'claude-code' && (
      hasSelectedFastCommand
      || (trimmed === CODEX_FAST_COMMAND && !hasSelectedSkill)
    )) {
      if (executeClaudeFastCommand()) return;
    }

    if (sessionProviderId === 'codex') {
      let commandInput: string | null = null;
      if (hasSelectedFastCommand) {
        commandInput = CODEX_FAST_COMMAND;
      } else if (hasSelectedCompactCommand) {
        commandInput = CODEX_COMPACT_COMMAND;
      } else if (
        hasSelectedSkill
        && skillPicker.selectedSkill
        && isReservedCodexSlashCommandName(skillPicker.selectedSkill.name)
      ) {
        commandInput = trimmed
          ? `/${skillPicker.selectedSkill.name} ${trimmed}`
          : `/${skillPicker.selectedSkill.name}`;
      } else if (!hasSelectedSkill) {
        commandInput = trimmed;
      }

      if (commandInput && dispatchCodexSlashCommand(commandInput)) return;
    }

    if (hasClientTerminalHandoff(sessionId)) {
      toast.info(t('chat.codexTerminalHandoffActive'));
      return;
    }
    // Use chip-selected skill or fallback to manual /skillname parsing
    const parsed = skillPicker.parseForSend(trimmed);

    // 미지원 슬래시 명령(Claude TUI 전용 — 헤드리스에서 동작 불가)은 터미널 fallback으로.
    if (
      !parsed
      && !hasSelectedSkill
      && session?.provider === 'claude-code'
      && shouldRouteToTerminalFallback(trimmed, skillPicker.sessionCommandNames)
    ) {
      if (openTerminalFallback(trimmed)) return;
    }

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

    // terminal-mode provider sessions route to their native PTY instead of a headless adapter.
    if (session?.kind === 'terminal' && sessionProviderId) {
      // 프리필은 터미널에 타이핑되는 순수 텍스트여야 한다. sendContent가 ContentBlock[]
      // (이미지 등 첨부)면 타이핑 불가하므로 텍스트만 넘긴다.
      const prefill = typeof sendContent === 'string' ? sendContent : textContent;
      if (launchProviderPty(sessionProviderId, prefill)) {
        clearInput();
        clearAttachments();
        clearSessionRefs();
        skillPicker.clearSkill();
        return;
      }
    }

    const shouldResumeSession = shouldResumeBeforeSend({
      hasExistingConversation,
      isStopped,
      sessionStatus,
    });

    if (shouldResumeSession && session && 'projectDir' in session) {
      void resumeAndSend(
        sessionId,
        session.projectDir,
        sendContent,
        skillName,
        displayContent,
        { forceTranslateInput },
      ).then((didSend) => {
        if (!didSend) return;
        clearInput();
        clearAttachments();
        clearSessionRefs();
        skillPicker.clearSkill();
      }).catch(() => {
        // Resume failures, including an active terminal handoff, intentionally
        // preserve the draft and attachments for a retry after the conflict ends.
      });
      return;
    } else {
      // First-time send for a session without a live CLI: attach composer defaults
      // so the server can spawn with the picked model / reasoning / permission mode.
      const providerId = sessionProviderId;
      if (!providerId) {
        toast.error(t('errors.providerRequired'));
        return;
      }
      const spawnConfig = buildSpawnConfigForCurrentSession();
      sendMessage(sessionId, sendContent, skillName, displayContent, spawnConfig, { forceTranslateInput });
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
    (skill: SkillInfo) => {
      if (sessionProviderId === 'codex' && isReservedCodexSlashCommandName(skill.name)) {
        dispatchCodexSlashCommand(`/${skill.name}`, 'picker');
        textareaRef.current?.focus();
        return;
      }
      if (skill.terminalFallback) {
        // 피커에서 클릭한 TUI 전용 명령 → 터미널 fallback으로 실행
        openTerminalFallback(`/${skill.name}`);
        textareaRef.current?.focus();
        return;
      }
      if (isCodexFastCommandSkill(skill)) {
        dispatchCodexSlashCommand(CODEX_FAST_COMMAND, 'picker');
        textareaRef.current?.focus();
        return;
      }
      if (isClaudeFastCommandSkill(skill)) {
        executeClaudeFastCommand();
        textareaRef.current?.focus();
        return;
      }
      if (isCodexCompactCommandSkill(skill)) {
        dispatchCodexSlashCommand(CODEX_COMPACT_COMMAND, 'picker');
        textareaRef.current?.focus();
        return;
      }
      skillPicker.selectSkill(skill);
      setInputValue('');
      textareaRef.current?.focus();
    },
    [
      dispatchCodexSlashCommand,
      executeClaudeFastCommand,
      openTerminalFallback,
      sessionProviderId,
      skillPicker,
    ],
  );

  const applyFilePick = useCallback(
    (
      result:
        | { newValue: string; newCursor: number; picked: { kind: 'file' | 'chat' | 'task'; value: string } }
        | null,
    ) => {
      if (!result) return;
      setInputValueFromProgrammaticEdit(result.newValue);
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
    [addSessionRef, sessionId, setDraftInput, setInputValueFromProgrammaticEdit],
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
        // An exact Codex built-in always owns its slash namespace, even when
        // an unrelated skill happens to fuzzy-match the same picker query.
        if (
          sessionProviderId === 'codex'
          && classifyCodexSlashCommand(inputValue.trim())
        ) {
          skillPicker.close();
          dispatchCodexSlashCommand(inputValue.trim(), 'picker');
          return;
        }
        // TUI 전용 미지원 슬래시 명령은 부분매칭 스킬이 피커에 떠 있어도(예: 이름/설명에
        // 'config'를 포함하는 명령) 그쪽으로 confirm되지 않도록, Enter 시 먼저 터미널
        // fallback 경로(handleSend)로 위임한다. (Tab 자동완성은 기존대로 동작)
        if (
          e.key === 'Enter'
          && !e.shiftKey
          && session?.provider === 'claude-code'
          && shouldRouteToTerminalFallback(inputValue.trim(), skillPicker.sessionCommandNames)
        ) {
          openTerminalFallback(inputValue.trim());
          return;
        }
        const confirmedSkill = skillPicker.confirm();
        if (confirmedSkill?.terminalFallback) {
          // 피커에서 고른 TUI 전용 명령(부분 입력 후 화살표로 선택한 경우 포함) → 터미널 fallback
          if (sessionProviderId === 'codex') {
            dispatchCodexSlashCommand(`/${confirmedSkill.name}`, 'picker');
          } else {
            openTerminalFallback(`/${confirmedSkill.name}`);
          }
          return;
        }
        if (confirmedSkill && isCodexFastCommandSkill(confirmedSkill)) {
          dispatchCodexSlashCommand(CODEX_FAST_COMMAND, 'picker');
          return;
        }
        if (confirmedSkill && isClaudeFastCommandSkill(confirmedSkill)) {
          executeClaudeFastCommand();
          return;
        }
        if (confirmedSkill && isCodexCompactCommandSkill(confirmedSkill)) {
          dispatchCodexSlashCommand(CODEX_COMPACT_COMMAND, 'picker');
          return;
        }
        if (confirmedSkill) {
          setInputValue('');
          return;
        }
        // 피커가 열렸지만 매칭된 스킬이 없는 경우(예: 헤드리스 미지원 슬래시 명령
        // /config, /agents 등)에는 Enter를 일반 전송 경로로 위임한다.
        // → handleSend가 터미널 fallback 또는 일반 전송을 처리한다. (Tab은 위임 안 함)
        if (e.key === 'Enter' && !e.shiftKey) {
          skillPicker.close();
          handleSend();
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

    // Configurable "translate & send" shortcut (default ⌥+Enter). Works for any combo
    // incl. non-Enter; translates the input to the agent's language then sends, even
    // when auto-translation is off.
    if (voiceState !== 'recording' && matchShortcut(e, translateSendShortcut)) {
      e.preventDefault();
      handleSend({ forceTranslate: true });
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
  const canSubmit = hasContent || !!skillPicker.selectedSkill;
  const canCreateFromCurrentSession = !isInputUnavailable &&
    !activePrompt &&
    hasExistingConversation &&
    !!activeProject &&
    !isInjectingCurrentSession;

  return (
    <>
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
                  <ComposerSessionControls
                    sessionId={sessionId}
                    variant="inline"
                    providerSessionOptions={providerSessionOptions}
                    surfaceActive={surfaceActive}
                  />
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
            isEmpty={skillPicker.isEmpty}
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
            <>
              <button
                type="button"
                onClick={handleCancel}
                data-testid="cancel-generation-btn"
                className="p-2 rounded-md transition-all duration-150 bg-(--error) text-white hover:bg-(--destructive-hover) scale-100"
                title={t('chat.cancelButton')}
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
              {!isVoiceActive && canSubmit && !isOverLimit && (
                <button
                  type="button"
                  onClick={() => handleSend()}
                  className="p-2 rounded-md bg-(--accent) text-white transition-all duration-150 hover:bg-(--accent-hover) scale-100"
                  title={t('chat.send')}
                  data-testid="send-during-generation-btn"
                >
                  <SendHorizontal className="w-4.5 h-4.5" />
                </button>
              )}
            </>
          ) : !isVoiceActive ? (
            <button
              onClick={() => handleSend()}
              disabled={isInputUnavailable || !!activePrompt || !canSubmit || isOverLimit}
              title={`${t('chat.send')}\n${t('chat.translateAndSend')} (${formatShortcut(translateSendShortcut)})`}
              className={cn(
                'p-2 rounded-md transition-all duration-150',
                canSubmit && !isInputUnavailable && !activePrompt && !isOverLimit
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
    <DeleteSessionDialog
      session={session ?? null}
      isOpen={deleteRequested}
      onCancel={() => setDeleteRequested(false)}
      onConfirm={async () => {
        const deleted = await deleteSession(sessionId);
        if (deleted) {
          setDeleteRequested(false);
        }
      }}
    />
    </>
  );
}
