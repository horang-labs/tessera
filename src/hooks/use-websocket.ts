import { useCallback, useEffect } from 'react';
import { wsClient } from '@/lib/ws/client';
import { useAuthStore } from '@/stores/auth-store';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { getProviderSessionRuntimeConfig } from '@/lib/settings/provider-defaults';
import { notifyProviderSessionStarted } from '@/lib/cli/provider-skill-onboarding';
import type { ContentBlock, SessionSpawnConfig } from '@/lib/ws/message-types';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';

export function useWebSocket() {
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    if (user?.id) {
      wsClient.connect(user.id);
    } else {
      wsClient.disconnect();
    }
    // No cleanup disconnect - singleton WebSocket manages its own lifecycle.
    // Disconnection happens when user becomes null (logout).
    // This prevents React StrictMode double-invoke from causing
    // connect → disconnect → reconnect cycles.
  }, [user?.id]);

  const sendMessage = useCallback(
    (
      sessionId: string,
      content: string | ContentBlock[],
      skillName?: string,
      displayContent?: string | ContentBlock[],
      spawnConfig?: SessionSpawnConfig,
      options?: { forceTranslateInput?: boolean },
    ) => {
      const session = projectViewWorkspaceState.resolveSession(sessionId);
      const providerId = session?.provider?.trim();
      wsClient.sendMessage(sessionId, content, skillName, displayContent, spawnConfig, options);
      if (providerId) notifyProviderSessionStarted(providerId, session?.hasStarted === true);
    },
    [],
  );

  const createSession = useCallback((args: { workDir?: string; providerId: string; executionMode?: AgentExecutionMode }) => {
    const { settings } = useSettingsStore.getState();
    const runtimeConfig = getProviderSessionRuntimeConfig(settings, args.providerId);
    wsClient.createSession({
      workDir: args.workDir,
      providerId: args.providerId,
      ...runtimeConfig,
      ...(args.executionMode && { executionMode: args.executionMode }),
    });
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    wsClient.closeSession(sessionId);
  }, []);

  const resumeSession = useCallback((sessionId: string) => {
    wsClient.resumeSession(sessionId);
  }, []);

  const retrySession = useCallback((sessionId: string) => {
    wsClient.retrySession(sessionId);
  }, []);

  const sendInteractiveResponse = useCallback(
    (sessionId: string, toolUseId: string, response: string): boolean => {
      return wsClient.sendInteractiveResponse(sessionId, toolUseId, response);
    },
    []
  );

  const cancelGeneration = useCallback((sessionId: string) => {
    wsClient.cancelGeneration(sessionId);
  }, []);

  const compactSession = useCallback((
    sessionId: string,
    spawnConfig?: SessionSpawnConfig,
    displayContent?: string,
  ) => {
    // This path is Codex-only, and Codex reports compaction just once it is
    // already finished (`thread/compacted`). Open the docked bar optimistically
    // so the user sees progress; the boundary event closes it. Claude Code
    // instead opens and closes the bar from its own `status` frames, which also
    // covers auto-compaction.
    useChatStore.getState().setCompacting(sessionId, Date.now());
    wsClient.compactSession(sessionId, spawnConfig, displayContent);
  }, []);

  const stopSession = useCallback((sessionId: string) => {
    wsClient.stopSession(sessionId);
  }, []);

  const setServiceTier = useCallback((sessionId: string, serviceTier: string | null, persist = true) => {
    wsClient.setServiceTier(sessionId, serviceTier, persist);
  }, []);

  const setFastMode = useCallback((sessionId: string, fastMode: boolean | null) => {
    wsClient.setFastMode(sessionId, fastMode);
  }, []);

  return {
    sendMessage,
    createSession,
    closeSession,
    resumeSession,
    retrySession,
    sendInteractiveResponse,
    cancelGeneration,
    compactSession,
    stopSession,
    setServiceTier,
    setFastMode,
  };
}
