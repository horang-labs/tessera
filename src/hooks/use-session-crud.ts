/**
 * Session CRUD Hook
 *
 * React hook providing session create, close, delete, and rename operations.
 */

import { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTabStore } from '@/stores/tab-store';
import { useTaskStore } from '@/stores/task-store';
import { generateSessionTitle } from '@/lib/session/title-generator';
import { getProviderSessionRuntimeConfig } from '@/lib/settings/provider-defaults';
import { toast } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import { captureTelemetryEvent } from '@/lib/telemetry/client';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { restoreSessionReplay } from '@/lib/chat/restore-session-replay';
import type { UnifiedSession } from '@/types/chat';

interface SessionCreateOptions {
  workDir?: string;
  parentProjectId?: string;
  worktreeBranch?: string;
  providerId: string;
  taskId?: string;
  collectionId?: string;
  title?: string;
  hasCustomTitle?: boolean;
}

export function useSessionCrud() {
  const { t } = useI18n();
  const sessionStore = useSessionStore();
  const chatStore = useChatStore();

  const [isCreating, setIsCreating] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [isForking, setIsForking] = useState(false);

  const requestSessionDelete = useCallback((sessionId: string) => {
    return fetchWithClientId(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  }, []);

  const removeSessionFromStores = useCallback(
    (sessionId: string, options?: { clearOnlyIfActive?: boolean }) => {
      const isActive = sessionStore.activeSessionId === sessionId;
      sessionStore.removeSession(sessionId);

      if (!options?.clearOnlyIfActive || isActive) {
        chatStore.clearSession(sessionId);
      }

      // 삭제된 세션을 표시하던 패널 → 빈 패널로 전환 (패널 자체는 유지)
      const panelState = usePanelStore.getState();
      const panels = selectActiveTab(panelState)?.panels ?? {};
      for (const [panelId, panel] of Object.entries(panels)) {
        if (panel.sessionId === sessionId) {
          panelState.assignSession(panelId, null);
        }
      }

      // Reload task-store so task sub-session lists reflect the deletion
      import('@/stores/task-store').then(({ useTaskStore }) => {
        const taskStore = useTaskStore.getState();
        const task = taskStore.getTaskBySessionId(sessionId);
        if (task) {
          taskStore.loadTasks(task.projectId, {
            setCurrent: taskStore.currentProjectId === task.projectId,
          });
        }
      });
    },
    [sessionStore, chatStore]
  );

  /**
   * Create a new session
   */
  const createSession = useCallback(
    async (options: SessionCreateOptions) => {
      const resolvedProviderId = options.providerId.trim();
      if (!resolvedProviderId) {
        toast.error(t('errors.providerRequired'));
        return null;
      }

      setIsCreating(true);
      const worktreeBranch = options.taskId ? options.worktreeBranch : undefined;

      // If active panel already has a session, create a new tab to preserve it
      const panelState = usePanelStore.getState();
      const tabData = selectActiveTab(panelState);
      const activePanel = tabData?.panels[tabData.activePanelId ?? ''];
      let createdTabId: string | undefined;
      if (activePanel?.sessionId != null) {
        createdTabId = useTabStore.getState().createTab();
      }

      const tempSessionId = `temp-${uuidv4()}`;
      const optimisticSession: UnifiedSession = {
        id: tempSessionId,
        title: t('panel.creating'),
        projectDir: options.parentProjectId || options.workDir || process.cwd(),
        workDir: options.workDir,
        isRunning: false,
        hasStarted: false,
        status: 'starting',
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        archived: false,
        sortOrder: 0,
        worktreeBranch,
        provider: resolvedProviderId,
        taskId: options.taskId,
        collectionId: options.collectionId,
      };

      sessionStore.addSession(optimisticSession);
      sessionStore.setCreatingSession(tempSessionId);
      chatStore.loadHistory(tempSessionId, []);

      // Assign temp session to the active panel (new empty tab or existing empty panel)
      {
        const ps = usePanelStore.getState();
        ps.assignSession(
          selectActiveTab(ps)?.activePanelId ?? '',
          tempSessionId,
        );
        useTabStore.getState().syncTabProjectFromSession(ps.activeTabId, tempSessionId);
      }

      const cleanupOnError = () => {
        sessionStore.removeSession(tempSessionId);
        sessionStore.setCreatingSession(null);
        if (createdTabId) {
          useTabStore.getState().closeTab(createdTabId);
        } else {
          const ps = usePanelStore.getState();
          ps.assignSession(
            selectActiveTab(ps)?.activePanelId ?? '',
            null,
          );
        }
      };

      try {
        const settings = useSettingsStore.getState().settings;
        const runtimeConfig = getProviderSessionRuntimeConfig(settings, resolvedProviderId);
        const response = await fetchWithClientId('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workDir: options.workDir,
            ...(options.title && { title: options.title }),
            ...(options.hasCustomTitle && { hasCustomTitle: true }),
            ...runtimeConfig,
            ...(resolvedProviderId && { providerId: resolvedProviderId }),
            ...(options.parentProjectId && { parentProjectId: options.parentProjectId }),
            ...(worktreeBranch && { worktreeBranch }),
            ...(options.taskId && { taskId: options.taskId }),
            ...(options.collectionId && { collectionId: options.collectionId }),
          }),
        });

        if (!response.ok) {
          if (response.status === 429) {
            toast.error(t('errors.sessionLimitReached', { current: 20, max: 20 }));
            cleanupOnError();
            return null;
          }
          throw new Error(t('errors.createSessionFailed'));
        }

        const result = await response.json();

        const projectDir = options.parentProjectId || result.projectDir || '';
        const projectExisted = sessionStore.projects.some(
          (p) => p.encodedDir === projectDir || p.decodedPath === projectDir
        );

        sessionStore.removeSession(tempSessionId);

        // CLI is not spawned until the first message — see session_started event.
        const newSession: UnifiedSession = {
          id: result.sessionId,
          title: result.title,
          projectDir: projectDir,
          workDir: options.workDir || result.projectDir,
          isRunning: false,
          hasStarted: false,
          status: result.status,
          createdAt: result.createdAt,
          lastModified: result.createdAt,
          tesseraSessionId: result.sessionId,
          archived: false,
          sortOrder: 0,
          worktreeBranch,
          kind: result.kind,
          provider: result.provider,
          model: result.model,
          reasoningEffort: result.reasoningEffort,
          serviceTier: result.serviceTier,
          fastMode: result.fastMode,
          sessionMode: result.sessionMode,
          accessMode: result.accessMode,
          taskId: options.taskId,
          collectionId: options.collectionId,
          hasCustomTitle: options.hasCustomTitle ?? false,
        };

        sessionStore.addSession(newSession);
        sessionStore.setCreatingSession(null);

        // Migrate draft input from temp session to real session
        // (preserves text the user typed while the API was in-flight)
        const tempDraft = chatStore.getDraftInput(tempSessionId);
        if (tempDraft) {
          chatStore.setDraftInput(result.sessionId, tempDraft);
        }

        // Update panel from temp to real session
        {
          const ps = usePanelStore.getState();
          ps.assignSession(
            selectActiveTab(ps)?.activePanelId ?? '',
            result.sessionId,
          );
          useTabStore.getState().syncTabProjectFromSession(ps.activeTabId, result.sessionId);
        }

        chatStore.loadHistory(result.sessionId, []);

        // Re-registered project: reload all projects to fetch historical sessions from DB
        if (!projectExisted) {
          useSessionStore.getState().loadProjects();
        }

        toast.success(t('notifications.sessionCreated', { title: result.title }));
        void captureTelemetryEvent('session_created', {
          provider_id: result.provider || resolvedProviderId,
          has_task: Boolean(options.taskId),
          has_worktree: Boolean(worktreeBranch),
          has_collection: Boolean(options.collectionId),
        });

        return result.sessionId;
      } catch (err) {
        cleanupOnError();
        toast.error(t('errors.createSessionFailed'));
        console.error('Create session error:', err);
        return null;
      } finally {
        setIsCreating(false);
      }
    },
    [sessionStore, chatStore, t]
  );

  /**
   * Close a session
   */
  const closeSession = useCallback(
    async (sessionId: string) => {
      setIsClosing(true);

      try {
        const response = await requestSessionDelete(sessionId);

        if (!response.ok) {
          throw new Error(t('errors.closeSessionFailed'));
        }

        removeSessionFromStores(sessionId, { clearOnlyIfActive: true });

        toast.success(t('notifications.sessionClosed'));
      } catch (err) {
        toast.error(t('errors.closeSessionFailed'));
        console.error('Close session error:', err);
      } finally {
        setIsClosing(false);
      }
    },
    [removeSessionFromStores, requestSessionDelete, t]
  );

  /**
   * Delete a session
   */
  const deleteSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const response = await requestSessionDelete(sessionId);

        if (!response.ok) {
          const error = await response.json();

          if (error.code === 'EACCES' || error.code === 'EBUSY') {
            toast.error(error.error || t('errors.deleteSessionFailed'));
            return false;
          }

          throw new Error(error.error || t('errors.deleteSessionFailed'));
        }

        removeSessionFromStores(sessionId);

        toast.success(t('notifications.sessionDeleted'));
        return true;
      } catch (err) {
        toast.error(t('errors.deleteSessionFailed'));
        console.error('Delete session error:', err);
        return false;
      }
    },
    [removeSessionFromStores, requestSessionDelete, t]
  );

  /** Fork a persisted Codex thread into a new, history-hydrated Tessera tab. */
  const forkSession = useCallback(
    async (sourceSessionId: string): Promise<string | null> => {
      if (isForking) return null;
      const tabStore = useTabStore.getState();
      const sourceTabId = tabStore.findSessionLocation(sourceSessionId)?.tabId
        ?? tabStore.activeTabId;
      setIsForking(true);
      try {
        const response = await fetchWithClientId(`/api/sessions/${sourceSessionId}/fork`, {
          method: 'POST',
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Failed to fork Codex session');
        }

        const forkedSession: UnifiedSession = {
          id: result.sessionId,
          title: result.title,
          projectDir: result.projectDir,
          workDir: result.workDir,
          isRunning: false,
          hasStarted: true,
          status: 'completed',
          createdAt: result.createdAt,
          lastModified: result.createdAt,
          archived: false,
          sortOrder: 0,
          worktreeBranch: result.worktreeBranch,
          provider: 'codex',
          model: result.model,
          reasoningEffort: result.reasoningEffort,
          serviceTier: result.serviceTier,
          taskId: result.taskId,
          collectionId: result.collectionId,
          hasCustomTitle: true,
        };
        // A sidebar single-click opens a preview tab, which is intentionally not
        // persisted. Forking makes the source meaningful workspace state, so pin
        // it before opening the child and keep their relative tab order stable.
        useTabStore.getState().pinTab(sourceTabId);
        sessionStore.addSession(forkedSession, { activate: false });

        // Create and activate the child tab only after its session exists. Keeping
        // addSession non-activating prevents the active-session bridge (including
        // cross-window sync) from replacing the source tab first.
        useTabStore.getState().createTab(result.sessionId, { insertAfterTabId: sourceTabId });

        try {
          const historyResponse = await fetch(`/api/sessions/${result.sessionId}/messages?limit=500`);
          restoreSessionReplay(
            result.sessionId,
            historyResponse.ok ? await historyResponse.json() : { messages: [] },
          );
        } catch (historyError) {
          // The fork is already durable. Leave the child open and allow the
          // normal history loader/reload path to hydrate it later.
          restoreSessionReplay(result.sessionId, { messages: [] });
          console.warn('Fork history hydration failed:', historyError);
        }

        toast.success(t('notifications.sessionCreated', { title: result.title }));

        if (result.taskId) {
          void useTaskStore.getState().loadTasks(result.projectDir, {
            setCurrent: useTaskStore.getState().currentProjectId === result.projectDir,
          });
        }
        return result.sessionId;
      } catch (error) {
        // The composer owns draft clearing and intentionally keeps it intact
        // when this returns null.
        toast.error(error instanceof Error ? error.message : t('errors.createSessionFailed'));
        console.error('Fork session error:', error);
        return null;
      } finally {
        setIsForking(false);
      }
    },
    [isForking, sessionStore, t],
  );

  /**
   * Remove a project from the sidebar (hides from registry).
   * Session files are NOT deleted.
   */
  const deleteProject = useCallback(
    async (encodedDir: string): Promise<void> => {
      try {
        const response = await fetchWithClientId(`/api/sessions/projects/${encodeURIComponent(encodedDir)}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error(t('errors.removeProjectFailed'));
        }

        sessionStore.removeProject(encodedDir);
        useTabStore.getState().removeProjectTabs(encodedDir);
        toast.success(t('notifications.projectRemoved'));
      } catch (err) {
        toast.error(t('errors.removeProjectFailed'));
        console.error('Remove project error:', err);
      }
    },
    [sessionStore, t]
  );

  /**
   * Rename a session
   */
  const renameSession = useCallback(
    async (sessionId: string, newTitle: string) => {
      const session = sessionStore.getSession(sessionId);
      const oldTitle = session?.title;
      const oldHasCustomTitle = session?.hasCustomTitle;
      const linkedTask = useTaskStore.getState().getTaskBySessionId(sessionId);
      const oldTaskTitle = linkedTask?.title;
      sessionStore.updateSessionTitle(sessionId, newTitle, true);
      useTaskStore.getState().syncLinkedTaskTitle(sessionId, newTitle);

      setIsRenaming(true);

      try {
        const response = await fetchWithClientId(`/api/sessions/${sessionId}/rename`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });

        if (!response.ok) {
          throw new Error(t('errors.renameSessionFailed'));
        }

        toast.success(t('notifications.sessionRenamed'));
      } catch (err) {
        if (oldTitle) {
          sessionStore.updateSessionTitle(sessionId, oldTitle, oldHasCustomTitle);
        }
        if (linkedTask?.sessions.length === 1 && oldTaskTitle) {
          useTaskStore.getState().syncLinkedTaskTitle(sessionId, oldTaskTitle);
        } else if (oldTitle) {
          useTaskStore.getState().syncLinkedTaskTitle(sessionId, oldTitle);
        }
        toast.error(t('errors.renameSessionFailed'));
        console.error('Rename session error:', err);
      } finally {
        setIsRenaming(false);
      }
    },
    [sessionStore, t]
  );

  /**
   * Auto-generate session title from first message.
   * Does NOT mark as custom title (so future auto-titles can still override).
   */
  const autoGenerateTitle = useCallback(
    (sessionId: string, firstMessage: string) => {
      const title = generateSessionTitle(firstMessage);
      if (title) {
        sessionStore.updateSessionTitle(sessionId, title);
        useTaskStore.getState().syncLinkedTaskTitle(sessionId, title);
      }
    },
    [sessionStore]
  );

  /**
   * Generate AI title for a session.
   * Calls the server-side AI title generation endpoint, which reads the JSONL
   * conversation and calls the active CLI provider to produce a title.
   */
  const generateTitle = useCallback(
    async (sessionId: string) => {
      // Prevent duplicate calls for the same session
      if (useSessionStore.getState().isGeneratingTitle(sessionId)) return;

      setIsGeneratingTitle(true);
      useSessionStore.getState().setGeneratingTitle(sessionId, true);

      try {
        const response = await fetchWithClientId(`/api/sessions/${sessionId}/generate-title`, {
          method: 'POST',
        });

        if (!response.ok) {
          const body = await response.json();
          if (body.code === 'no_conversation') {
            toast.warning(t('notifications.noConversationYet'));
            return;
          }
          throw new Error(body.error || t('errors.generateTitleFailed'));
        }

        const result = await response.json() as { title: string };

        sessionStore.updateSessionTitle(sessionId, result.title, true);
        useTaskStore.getState().syncLinkedTaskTitle(sessionId, result.title);

        toast.success(t('notifications.titleGenerated'));
      } catch (err) {
        toast.error(t('errors.generateTitleFailed'));
        console.error('Generate title error:', err);
      } finally {
        setIsGeneratingTitle(false);
        useSessionStore.getState().setGeneratingTitle(sessionId, false);
      }
    },
    [sessionStore, t]
  );

  return {
    createSession,
    closeSession,
    deleteSession,
    forkSession,
    deleteProject,
    renameSession,
    autoGenerateTitle,
    generateTitle,

    isCreating,
    isClosing,
    isRenaming,
    isGeneratingTitle,
    isForking,

    activeSessionId: sessionStore.activeSessionId,
  };
}
