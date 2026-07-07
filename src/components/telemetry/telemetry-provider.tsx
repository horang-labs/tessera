'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { useSessionStore } from '@/stores/session-store';
import {
  captureTelemetryEvent,
  captureTelemetryFirstRun,
  configureTelemetry,
  createTelemetrySessionId,
  type TelemetryRuntimeContext,
} from '@/lib/telemetry/client';
import type { TelemetryBootstrapInfo } from '@/lib/telemetry/server-state';

const ACTIVE_TICK_MS = 15_000;
const HEARTBEAT_MS = 300_000;
const IDLE_TIMEOUT_MS = 300_000;

type TelemetryBootstrapResponse = TelemetryBootstrapInfo;

export function TelemetryProvider() {
  const telemetrySettingEnabled = useSettingsStore(
    (state) => state.settings.telemetry.enabled,
  );
  const activeProviderId = useSessionStore((state) => {
    if (!state.activeSessionId) return null;
    return state.getSession(state.activeSessionId)?.provider ?? null;
  });

  const [appSessionId] = useState(createTelemetrySessionId);
  const [bootstrap, setBootstrap] = useState<TelemetryBootstrapResponse | null>(null);
  const appStartedCapturedRef = useRef(false);
  const firstRunCaptureStartedRef = useRef(false);
  const previousProviderRef = useRef<string | null>(null);
  const activeProviderIdRef = useRef<string | null>(null);
  const contextServerHostInfo = bootstrap?.serverHostInfo ?? null;
  const installId = bootstrap?.installId ?? null;

  const telemetryAllowed = Boolean(
    bootstrap
      && telemetrySettingEnabled
      && !bootstrap.serverHostInfo.telemetryDisabledByEnv,
  );

  const telemetryContext = useMemo<TelemetryRuntimeContext | null>(() => {
    if (!contextServerHostInfo || !installId) return null;

    return {
      installId,
      appSessionId,
      appVersion: contextServerHostInfo.appVersion,
      platform: contextServerHostInfo.platform,
      arch: contextServerHostInfo.arch,
      channel: contextServerHostInfo.channel,
    };
  }, [appSessionId, contextServerHostInfo, installId]);

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
      try {
        const response = await fetch('/api/telemetry/bootstrap', { cache: 'no-store' });
        if (!response.ok) return;
        const nextBootstrap = await response.json() as TelemetryBootstrapResponse;
        if (!cancelled) setBootstrap(nextBootstrap);
      } catch {
        // Telemetry bootstrap failure must not affect app startup.
      }
    }

    void loadBootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!bootstrap || !bootstrap.firstRunEligible) return;
    if (firstRunCaptureStartedRef.current) return;

    firstRunCaptureStartedRef.current = true;
    const firstRunContext: TelemetryRuntimeContext = {
      installId: bootstrap.installId,
      appSessionId,
      appVersion: bootstrap.serverHostInfo.appVersion,
      platform: bootstrap.serverHostInfo.platform,
      arch: bootstrap.serverHostInfo.arch,
      channel: bootstrap.serverHostInfo.channel,
    };

    void (async () => {
      const result = await captureTelemetryFirstRun(firstRunContext);
      if (result === 'failed') {
        firstRunCaptureStartedRef.current = false;
        return;
      }

      try {
        await fetch('/api/telemetry/first-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: result === 'captured' ? 'captured' : 'skipped',
            ...(result === 'disabled' ? { skipReason: 'client_disabled' } : {}),
          }),
        });
      } catch {
        // A missed marker may retry on the next app load; no user-visible error.
      }
    })();
  }, [appSessionId, bootstrap]);

  useEffect(() => {
    configureTelemetry(telemetryContext, telemetryAllowed);

    if (telemetryAllowed && telemetryContext && !appStartedCapturedRef.current) {
      appStartedCapturedRef.current = true;
      void captureTelemetryEvent('app_started');
    }
  }, [telemetryAllowed, telemetryContext]);

  useEffect(() => {
    activeProviderIdRef.current = activeProviderId;

    if (!telemetryAllowed || !activeProviderId) return;
    if (previousProviderRef.current === activeProviderId) return;

    previousProviderRef.current = activeProviderId;
    void captureTelemetryEvent('provider_selected', {
      provider_id: activeProviderId,
    });
  }, [activeProviderId, telemetryAllowed]);

  useEffect(() => {
    if (!telemetryAllowed || !telemetryContext) return undefined;

    let pendingActiveSeconds = 0;
    let lastTickMs = Date.now();
    let lastHeartbeatMs = Date.now();
    let lastInputMs = Date.now();

    const markActive = () => {
      lastInputMs = Date.now();
    };

    const isActive = (now: number) => {
      const hasFocus = typeof document.hasFocus !== 'function' || document.hasFocus();
      return document.visibilityState === 'visible'
        && hasFocus
        && now - lastInputMs < IDLE_TIMEOUT_MS;
    };

    const accumulate = () => {
      const now = Date.now();
      const deltaSeconds = Math.max(0, (now - lastTickMs) / 1000);
      lastTickMs = now;

      if (isActive(now)) {
        pendingActiveSeconds += deltaSeconds;
      }
    };

    const tick = () => {
      accumulate();
      const now = Date.now();
      if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
        lastHeartbeatMs = now;
        flush();
      }
    };

    const flush = () => {
      accumulate();
      const activeSeconds = Math.floor(pendingActiveSeconds);
      if (activeSeconds <= 0) return;

      pendingActiveSeconds -= activeSeconds;
      void captureTelemetryEvent('app_usage_heartbeat', {
        active_seconds: activeSeconds,
      });

      const providerId = activeProviderIdRef.current;
      if (providerId) {
        void captureTelemetryEvent('agent_usage_heartbeat', {
          active_seconds: activeSeconds,
          provider_id: providerId,
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('mousemove', markActive, { passive: true });
    window.addEventListener('pointerdown', markActive, { passive: true });
    window.addEventListener('keydown', markActive);
    window.addEventListener('touchstart', markActive, { passive: true });
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const intervalId = window.setInterval(tick, ACTIVE_TICK_MS);

    return () => {
      flush();
      window.clearInterval(intervalId);
      window.removeEventListener('mousemove', markActive);
      window.removeEventListener('pointerdown', markActive);
      window.removeEventListener('keydown', markActive);
      window.removeEventListener('touchstart', markActive);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [telemetryAllowed, telemetryContext]);

  return null;
}
