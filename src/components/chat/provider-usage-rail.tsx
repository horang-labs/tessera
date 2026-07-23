'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProviderLogoMark, getProviderBrand } from './provider-brand';
import { useRateLimitStore } from '@/stores/rate-limit-store';
import {
  buildProviderUsageRailModel,
  type ProviderUsageRailModel,
  type ProviderUsageRailWindow,
} from '@/lib/status-display/provider-usage-rail';
import { cn } from '@/lib/utils';
import { useAnchoredPopover } from '@/hooks/use-anchored-popover';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';

const POPOVER_WIDTH = 288;
const POPOVER_ESTIMATED_HEIGHT = 320;

function usageText(window: ProviderUsageRailWindow | null): string {
  return window ? String(window.usedPercent) : '--';
}

function severityText(window: ProviderUsageRailWindow | null): string {
  if (window?.severity === 'danger') return 'text-(--status-error-text)';
  if (window?.severity === 'warning') return 'text-(--status-warning-text)';
  return window ? 'text-(--text-secondary)' : 'text-(--text-muted)';
}

function severityBar(window: ProviderUsageRailWindow | null): string {
  if (window?.severity === 'danger') return 'bg-red-400';
  if (window?.severity === 'warning') return 'bg-yellow-400';
  return 'bg-(--accent)';
}

function formatResetTime(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '--';
  const diffMs = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'now';

  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function DetailRow({
  label,
  window,
  now,
}: {
  label: string;
  window: ProviderUsageRailWindow | null;
  now: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-(--text-secondary)">{label}</span>
        <span className="flex items-center gap-2 font-mono tabular-nums">
          <span className={severityText(window)}>
            {window ? `${window.usedPercent}%` : '--'}
          </span>
          <span className="min-w-[52px] text-right text-(--text-muted)">
            {window ? formatResetTime(window.resetsAt, now) : '--'}
          </span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-(--divider)">
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', severityBar(window))}
          style={{ width: `${window?.usedPercent ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function ProviderDetails({ model, now }: { model: ProviderUsageRailModel; now: number }) {
  const brand = getProviderBrand(model.providerId);
  return (
    <section className="space-y-3" data-testid={`provider-usage-detail-${model.providerId}`}>
      <div className="flex items-center gap-2">
        <ProviderLogoMark providerId={model.providerId} className="h-5 w-5" />
        <span className="text-[12px] font-medium text-(--text-primary)">{brand.displayName}</span>
      </div>
      <DetailRow label={model.shortTerm?.label ?? '5-hour limit'} window={model.shortTerm} now={now} />
      <DetailRow label="Weekly limit" window={model.weekly} now={now} />
    </section>
  );
}

export function ProviderUsageRail() {
  const claudeSnapshot = useRateLimitStore(
    (state) => state.limitsByProvider['claude-code'] ?? null,
  );
  const codexSnapshot = useRateLimitStore(
    (state) => state.limitsByProvider.codex ?? null,
  );
  const models = useMemo(
    () => [
      buildProviderUsageRailModel('claude-code', claudeSnapshot),
      buildProviderUsageRailModel('codex', codexSnapshot),
    ],
    [claudeSnapshot, codexSnapshot],
  );
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [openProviderId, setOpenProviderId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const isOpen = openProviderId !== null;
  const close = useCallback(() => setOpenProviderId(null), []);
  const calculatePosition = useCallback((trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    const maxTop = Math.max(8, window.innerHeight - POPOVER_ESTIMATED_HEIGHT - 8);
    return {
      left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - POPOVER_WIDTH - 8)),
      top: Math.min(Math.max(8, rect.top - 96), maxTop),
    };
  }, []);
  const { position: popoverPosition, updatePosition } = useAnchoredPopover({
    isOpen,
    onClose: close,
    triggerRef,
    containerRef: railRef,
    popoverRef,
    calculatePosition,
  });
  useCloseOnEscape(close, { enabled: isOpen, capture: true });

  useEffect(() => {
    if (!isOpen) return;
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  const toggleDetails = (providerId: string, trigger: HTMLButtonElement) => {
    if (openProviderId === providerId) {
      close();
      return;
    }
    triggerRef.current = trigger;
    updatePosition();
    setOpenProviderId(providerId);
  };

  return (
    <>
      <div ref={railRef} className="flex flex-col items-center py-1" data-testid="provider-usage-rail">
        {models.map((model) => {
          const brand = getProviderBrand(model.providerId);
          return (
            <button
              key={model.providerId}
              type="button"
              onClick={(event) => toggleDetails(model.providerId, event.currentTarget)}
              className="group flex h-10 w-11 flex-col items-center justify-center gap-0.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-secondary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)"
              aria-label={`${brand.displayName} usage: ${model.shortTerm?.label ?? '5-hour limit'} ${usageText(model.shortTerm)}%, weekly ${usageText(model.weekly)}%`}
              aria-expanded={openProviderId === model.providerId}
              aria-haspopup="dialog"
              data-testid={`provider-usage-${model.providerId}`}
            >
              <div className="flex w-full items-center justify-center gap-1">
                <ProviderLogoMark
                  providerId={model.providerId}
                  className="h-3.5 w-3.5 rounded-[3px]"
                  iconClassName="h-2.5 w-2.5"
                />
                <span className="text-[8px] font-medium leading-none">{model.providerId === 'codex' ? 'CX' : 'CC'}</span>
              </div>
              <span className="grid w-[34px] grid-cols-2 text-center font-mono text-[8px] leading-none tabular-nums">
                <span>{model.shortTerm?.shortLabel ?? '5h'}</span><span>W</span>
                <span className={cn('mt-0.5', severityText(model.shortTerm))}>{usageText(model.shortTerm)}</span>
                <span className={cn('mt-0.5', severityText(model.weekly))}>{usageText(model.weekly)}</span>
              </span>
            </button>
          );
        })}
      </div>

      {isOpen && popoverPosition && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Usage limits"
          className="fixed z-50 w-72 rounded-xl border border-(--divider) bg-(--sidebar-bg) p-4 shadow-[0_12px_36px_rgba(0,0,0,0.28)]"
          style={popoverPosition}
          data-testid="provider-usage-popover"
        >
          <div className="mb-4">
            <h2 className="text-[13px] font-semibold text-(--text-primary)">Usage limits</h2>
            <p className="mt-0.5 text-[10px] text-(--text-muted)">Resets shown as time remaining</p>
          </div>
          <div className="space-y-4">
            {models.map((model, index) => (
              <div key={model.providerId}>
                {index > 0 && <div className="mb-4 border-t border-(--divider)" />}
                <ProviderDetails model={model} now={now} />
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
