/**
 * Session Resume Hook
 *
 * React hook providing session resume, resumeAndSend, and retrySession operations.
 */

import { useCallback, useState } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { wsClient } from '@/lib/ws/client';
import { restoreSessionReplay } from '@/lib/chat/restore-session-replay';
import {
  applyProviderSessionRuntimeOverrides,
  getProviderSessionRuntimeConfig,
} from '@/lib/settings/provider-defaults';
import { toast } from '@/stores/notification-store';
import { i18n } from '@/lib/i18n';
import type { ContentBlock } from '@/lib/ws/message-types';

export function useSessionResume() {
  const sessionStore = useSessionStore();
  const chatStore = useChatStore();

  const [isResuming, setIsResuming] = useState(false);

  /**
   * Resume a session (load history and start CLI process)
   */
  const resumeSession = useCallback(
    async (sessionId: string) => {
      setIsResuming(true);

      try {
        const settings = useSettingsStore.getState().settings;
        const providerId = sessionStore.getSession(sessionId)?.provider?.trim();
        if (!providerId) {
          throw new Error('Session has no provider');
        }
        const runtimeConfig = applyProviderSessionRuntimeOverrides(
          getProviderSessionRuntimeConfig(settings, providerId),
          sessionStore.getSession(sessionId),
          providerId,
        );
        const response = await fetch(`/api/sessions/${sessionId}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runtimeConfig),
        });

        if (!response.ok) {
          if (response.status === 404) {
            // Session metadata or workDir not found — load canonical Tessera history read-only
            toast.error(i18n.t('notifications.sessionFileNotFound'));
            try {
              const msgRes = await fetch(`/api/sessions/${sessionId}/messages`);
              if (msgRes.ok) {
                const data = await msgRes.json();
                restoreSessionReplay(sessionId, data);
              }
            } catch { /* non-fatal */ }
            // Keep original status — don't overwrite
            sessionStore.setActiveSession(sessionId);
            return;
          }
          throw new Error('Failed to resume session');
        }

        const result = await response.json();

        if (result.status === 'read_only') {
          restoreSessionReplay(sessionId, result);
          sessionStore.updateSessionStatus(sessionId, 'stopped');
          sessionStore.setActiveSession(sessionId);
          toast.warning(i18n.t('notifications.sessionReadOnlyWarning'));
          sessionStore.markSessionReadOnly(sessionId, true);
          return;
        }

        sessionStore.markSessionRunning(sessionId, result.sessionId || sessionId, {
          model: result.model,
          reasoningEffort: result.reasoningEffort,
          sessionMode: runtimeConfig.sessionMode,
          accessMode: runtimeConfig.accessMode,
        });
        sessionStore.setActiveSession(sessionId);

        toast.success(i18n.t('notifications.sessionResumed'));
      } catch (err) {
        toast.error(i18n.t('errors.sessionResumeFailed'));
        console.error('Resume session error:', err);
      } finally {
        setIsResuming(false);
      }
    },
    [sessionStore]
  );

  /**
   * Resume a read-only session and send a message.
   * Used when user sends a message to a read-only session.
   */
  const resumeAndSend = useCallback(
    async (sessionId: string, _projectDir: string, content: string | ContentBlock[], skillName?: string, displayContent?: string | ContentBlock[]) => {
      setIsResuming(true);

      try {
        const settings = useSettingsStore.getState().settings;
        const providerId = sessionStore.getSession(sessionId)?.provider?.trim();
        if (!providerId) {
          throw new Error('Session has no provider');
        }
        const runtimeConfig = applyProviderSessionRuntimeOverrides(
          getProviderSessionRuntimeConfig(settings, providerId),
          sessionStore.getSession(sessionId),
          providerId,
        );
        const response = await fetch(`/api/sessions/${sessionId}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runtimeConfig),
        });

        if (!response.ok) {
          throw new Error('Failed to resume session');
        }

        const result = await response.json();

        if (result.status === 'read_only') {
          restoreSessionReplay(sessionId, result);
          sessionStore.updateSessionStatus(sessionId, 'stopped');
          sessionStore.setActiveSession(sessionId);
          sessionStore.markSessionReadOnly(sessionId, true);
          toast.warning(i18n.t('notifications.sessionReadOnlyWarning'));
          return;
        }

        sessionStore.markSessionRunning(sessionId, result.sessionId || sessionId, {
          model: result.model,
          reasoningEffort: result.reasoningEffort,
          sessionMode: runtimeConfig.sessionMode,
          accessMode: runtimeConfig.accessMode,
        });

        // Remove optimistic messages (will be replaced by WebSocket messages)
        chatStore.clearSessionMessages(sessionId);

        if (displayContent !== undefined) {
          wsClient.sendMessage(sessionId, content, skillName, displayContent);
        } else {
          wsClient.sendMessage(sessionId, content, skillName);
        }

        toast.success(i18n.t('notifications.sessionResumed'));
      } catch (err) {
        toast.error(i18n.t('errors.sessionResumeFailed'));
        console.error('Resume and send error:', err);
        throw err;
      } finally {
        setIsResuming(false);
      }
    },
    [sessionStore, chatStore]
  );

  /**
   * Retry a failed session
   */
  const retrySession = useCallback(
    (sessionId: string) => {
      sessionStore.updateSessionStatus(sessionId, 'running');
      wsClient.retrySession(sessionId);
      toast.success(i18n.t('notifications.retryingSession'));
    },
    [sessionStore]
  );

  return {
    resumeSession,
    resumeAndSend,
    retrySession,

    isResuming,
  };
}
