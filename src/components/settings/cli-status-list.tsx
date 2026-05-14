'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { wsClient } from '@/lib/ws/client';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';
import {
  captureTelemetryEvent,
  normalizeTelemetryProviderSetupIssueStatus,
} from '@/lib/telemetry/client';
import type { CliStatusEntry } from '@/lib/cli/connection-checker';

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  opencode: 'OpenCode',
};

const STATUS_DOT_CLASS: Record<CliStatusEntry['status'], string> = {
  connected: 'bg-green-500',
  needs_login: 'bg-yellow-500',
  not_installed: 'bg-gray-400',
};

export default function CliStatusList() {
  const { t } = useI18n();
  const cliCommandOverridesKey = useSettingsStore((state) => (
    JSON.stringify(state.settings.cliCommandOverrides ?? {})
  ));
  // null = loading, [] = no providers registered, undefined = disconnected / server error
  const [entries, setEntries] = useState<CliStatusEntry[] | null | undefined>(null);
  const reportedIssueKeysRef = useRef<Set<string>>(new Set());

  const fetchStatus = useCallback(() => {
    setEntries(null);
    wsClient.checkCliStatus((results) => {
      // Treat disconnect (null from client) and server-error (null after prior fix) the same
      setEntries(results ?? undefined);
    });
  }, []);

  useEffect(() => {
    let isMounted = true;

    wsClient.checkCliStatus((results) => {
      if (!isMounted) return;
      setEntries(results ?? undefined);
    });

    return () => {
      isMounted = false;
    };
  }, [cliCommandOverridesKey]);

  const shouldShowEnvTag = useMemo(() => {
    if (!entries || entries.length === 0) return new Set<string>();
    const counts = new Map<string, number>();
    for (const e of entries) {
      counts.set(e.providerId, (counts.get(e.providerId) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  }, [entries]);

  const STATUS_LABELS: Record<CliStatusEntry['status'], string> = {
    connected: t('settings.cliStatus.status.connected'),
    needs_login: t('settings.cliStatus.status.needs_login'),
    not_installed: t('settings.cliStatus.status.not_installed'),
  };

  const ENV_LABELS: Record<CliStatusEntry['environment'], string> = {
    native: t('settings.cliStatus.env.native'),
    wsl: t('settings.cliStatus.env.wsl'),
  };

  useEffect(() => {
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const issueStatus = normalizeTelemetryProviderSetupIssueStatus(entry.status);
      if (!issueStatus) continue;

      const key = `settings:${entry.providerId}:${entry.environment}:${issueStatus}`;
      if (reportedIssueKeysRef.current.has(key)) continue;
      reportedIssueKeysRef.current.add(key);
      void captureTelemetryEvent('provider_setup_issue_seen', {
        source: 'settings',
        provider_id: entry.providerId,
        status: issueStatus,
      });
    }
  }, [entries]);

  return (
    <div className="space-y-2">
      {entries === null && (
        <div
          role="status"
          data-testid="cli-status-loading"
          className="text-sm text-(--text-muted)"
        >
          {t('settings.cliStatus.loading')}
        </div>
      )}

      {entries === undefined && (
        <div
          role="status"
          data-testid="cli-status-disconnected"
          className="text-sm text-(--text-muted)"
        >
          {t('settings.cliStatus.disconnected')}
        </div>
      )}

      {Array.isArray(entries) && entries.length === 0 && (
        <div className="text-sm text-(--text-muted)">
          {t('settings.cliStatus.empty')}
        </div>
      )}

      {Array.isArray(entries) && entries.map((e) => {
        const displayName = PROVIDER_DISPLAY_NAMES[e.providerId] ?? e.providerId;
        const envSuffix = shouldShowEnvTag.has(e.providerId) ? ` (${ENV_LABELS[e.environment]})` : '';
        return (
          <div
            key={`${e.providerId}-${e.environment}`}
            data-testid={`cli-status-row-${e.providerId}-${e.environment}`}
            className="flex items-center justify-between py-1.5 text-sm"
          >
            <span className="text-(--text-primary)">
              {displayName}{envSuffix}
            </span>
            <span className="flex items-center gap-2 text-(--text-muted)">
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${STATUS_DOT_CLASS[e.status]}`}
              />
              <span>{STATUS_LABELS[e.status]}</span>
              {e.version && <span className="opacity-70">v{e.version}</span>}
            </span>
          </div>
        );
      })}

      <div className="flex justify-end pt-1">
        <button
          type="button"
          data-testid="cli-status-refresh"
          onClick={fetchStatus}
          disabled={entries === null}
          className="text-xs px-2 py-1 rounded-md border border-(--divider) hover:bg-(--sidebar-hover) text-(--text-primary) disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          {t('settings.cliStatus.refresh')}
        </button>
      </div>
    </div>
  );
}
