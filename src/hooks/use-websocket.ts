import { useCallback, useEffect } from 'react';
import { wsClient } from '@/lib/ws/client';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { getProviderSessionRuntimeConfig } from '@/lib/settings/provider-defaults';
import type { ContentBlock, PermissionMode } from '@/lib/ws/message-types';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';

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
      spawnConfig?: ({ model?: string; reasoningEffort?: string | null; permissionMode?: PermissionMode } & ProviderRuntimeControls),
    ) => {
      wsClient.sendMessage(sessionId, content, skillName, displayContent, spawnConfig);
    },
    [],
  );

  const createSession = useCallback((args: { workDir?: string; providerId: string }) => {
    const { settings } = useSettingsStore.getState();
    const runtimeConfig = getProviderSessionRuntimeConfig(settings, args.providerId);
    wsClient.createSession({
      workDir: args.workDir,
      providerId: args.providerId,
      ...runtimeConfig,
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

  const stopSession = useCallback((sessionId: string) => {
    wsClient.stopSession(sessionId);
  }, []);

  return {
    sendMessage,
    createSession,
    closeSession,
    resumeSession,
    retrySession,
    sendInteractiveResponse,
    cancelGeneration,
    stopSession,
  };
}
