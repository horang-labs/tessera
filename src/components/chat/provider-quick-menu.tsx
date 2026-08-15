'use client';

import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/stores/providers-store';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import { useI18n } from '@/lib/i18n';
import type { ProviderMeta } from '@/lib/cli/providers/types';
import {
  getProviderExecutionCapabilities,
  resolveEffectiveExecutionMode,
  type AgentExecutionMode,
  type ProviderExecutionCapabilities,
} from '@/lib/session/agent-execution-mode';
import { ExecutionModeSelector } from '@/components/session/execution-mode-selector';
import { ProviderLogoMark } from './provider-brand';
import { useSettingsStore } from '@/stores/settings-store';
import { ProviderExecutionBadge } from './provider-execution-badge';

interface ProviderQuickMenuProps {
  anchorRect: DOMRect;
  /** Provider currently bound to the task — rendered with a subtle "current" hint. */
  currentProviderId?: string;
  onSelect: (providerId: string, executionMode: AgentExecutionMode) => void;
  onClose: () => void;
}

const MENU_WIDTH = 216;
const ITEM_HEIGHT = 32;
const EXECUTION_MODE_SECTION_HEIGHT = 38;
const PADDING = 6;

/** Union of what the offered providers can run, so an unusable radio stays disabled. */
export function getQuickMenuExecutionCapabilities(
  providerIds: readonly string[],
): ProviderExecutionCapabilities {
  return providerIds.reduce<ProviderExecutionCapabilities>(
    (accumulated, providerId) => {
      const capabilities = getProviderExecutionCapabilities(providerId);
      return {
        pty: accumulated.pty || capabilities.pty,
        gui: accumulated.gui || capabilities.gui,
      };
    },
    { pty: false, gui: false },
  );
}

/**
 * The global default can be unusable for every provider on offer — fall back to
 * one that works instead of disabling the whole list.
 */
export function resolveQuickMenuExecutionMode(
  requestedMode: AgentExecutionMode,
  capabilities: ProviderExecutionCapabilities,
): AgentExecutionMode {
  if (capabilities[requestedMode]) return requestedMode;
  if (!capabilities.pty && !capabilities.gui) return requestedMode;
  return resolveEffectiveExecutionMode(requestedMode, capabilities);
}

export function ProviderQuickMenu({
  anchorRect,
  currentProviderId,
  onSelect,
  onClose,
}: ProviderQuickMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const executionModeInputName = useId();
  const providers = useProvidersStore((s) => s.providers);
  const initialized = useProvidersStore((s) => s.initialized);
  const fetchProviders = useProvidersStore((s) => s.fetch);
  const refreshProviders = useProvidersStore((s) => s.refresh);
  const loading = useProvidersStore((s) => s.loading);
  const defaultExecutionMode = useSettingsStore((s) => s.settings.agentExecutionMode);
  const [requestedExecutionMode, setRequestedExecutionMode] = useState<AgentExecutionMode>(defaultExecutionMode);

  useEffect(() => {
    if (providers === null && !initialized && !loading) fetchProviders();
  }, [providers, initialized, loading, fetchProviders]);

  useCloseOnEscape(onClose, { capture: true });

  const selectable = useMemo<ProviderMeta[]>(
    () => (providers ?? []).filter((p) => p.status === 'connected'),
    [providers],
  );
  const showLoading = (providers === null && (loading || !initialized)) || (loading && selectable.length === 0);
  const showExecutionModes = !showLoading && selectable.length > 0;

  const menuCapabilities = useMemo(
    () => getQuickMenuExecutionCapabilities(selectable.map((provider) => provider.id)),
    [selectable],
  );
  const agentExecutionMode = resolveQuickMenuExecutionMode(requestedExecutionMode, menuCapabilities);

  const menuPos = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rowCount = Math.max(selectable.length, 1);
    const menuHeight = rowCount * ITEM_HEIGHT
      + (showExecutionModes ? EXECUTION_MODE_SECTION_HEIGHT : 0)
      + PADDING * 2;

    let top = anchorRect.bottom + 4;
    let left = anchorRect.left;
    if (top + menuHeight > vh - 8) top = anchorRect.top - menuHeight - 4;
    if (left + MENU_WIDTH > vw - 8) left = vw - MENU_WIDTH - 8;
    if (left < 8) left = 8;
    return { top, left };
  }, [anchorRect, selectable.length, showExecutionModes]);

  useEffect(function handleOutsideClick() {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target)) onClose();
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [onClose]);

  useEffect(function focusFirstItem() {
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    firstItem?.focus();
  }, []);

  const handleMenuKeyDown = useMenuNavigation(menuRef);

  if (typeof document === 'undefined' || !menuPos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Choose CLI provider for new session"
      className={cn(
        'fixed z-[9999] min-w-[200px] rounded-lg p-1.5',
        'bg-(--sidebar-bg) border border-(--divider)',
        'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
      )}
      style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
      onKeyDown={handleMenuKeyDown}
      data-testid="provider-quick-menu"
    >
      {showLoading ? (
        <div className="px-3 py-2 text-[12px] text-(--text-muted)">Loading providers...</div>
      ) : providers === null ? (
        <button
          {...telemetryClickAttributes('composer.provider.refresh', 'composer')}
          role="menuitem"
          type="button"
          onClick={refreshProviders}
          className={cn(
            'w-full flex items-center gap-2 px-3 h-8 text-[12px] text-left rounded-md',
            'text-(--sidebar-text-active) transition-colors',
            'hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
          )}
        >
          Check providers again
        </button>
      ) : selectable.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-(--text-muted)">No CLI available</div>
      ) : (
        selectable.map((provider) => {
          const isCurrent = provider.id === currentProviderId;
          const isUnsupported = !getProviderExecutionCapabilities(provider.id)[agentExecutionMode];
          return (
            <button
              {...telemetryClickAttributes('composer.provider.select', 'composer')}
              key={provider.id}
              role="menuitem"
              type="button"
              disabled={isUnsupported}
              title={isUnsupported ? t('settings.executionMode.unsupported') : undefined}
              onClick={() => {
                onSelect(provider.id, agentExecutionMode);
                onClose();
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 h-8 text-[12px] text-left rounded-md',
                'text-(--sidebar-text-active) transition-colors',
                'focus:outline-none',
                isUnsupported
                  ? 'cursor-not-allowed opacity-45'
                  : 'cursor-default hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover)',
              )}
              data-testid={`provider-quick-menu-item-${provider.id}`}
            >
              <ProviderLogoMark
                providerId={provider.id}
                className="h-4 w-4 rounded-[4px]"
                iconClassName="h-2.5 w-2.5"
              />
              <span className="flex-1 truncate">{provider.displayName}</span>
              <ProviderExecutionBadge
                preferredMode={agentExecutionMode}
                providerId={provider.id}
                testId={`provider-quick-menu-item-${provider.id}-pty-only`}
              />
              {isCurrent && (
                <span className="text-[10px] text-(--text-muted)">current</span>
              )}
            </button>
          );
        })
      )}

      {showExecutionModes && (
        <div className="mt-1 space-y-1 border-t border-(--divider) px-1.5 pt-1.5">
          <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
            {t('task.creation.agentUiLabel')}
          </span>
          <ExecutionModeSelector
            value={agentExecutionMode}
            onChange={setRequestedExecutionMode}
            capabilities={menuCapabilities}
            density="mini"
            name={executionModeInputName}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
