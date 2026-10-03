'use client';

import type { ReactNode, SyntheticEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const automationField = 'w-full min-w-0 rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 text-sm text-(--input-text) outline-none placeholder:text-(--input-placeholder) focus:border-(--accent) focus:ring-2 focus:ring-(--accent)/20 disabled:opacity-60 min-h-10 max-sm:min-h-11';
export const automationDisclosure = 'rounded-lg border border-(--divider) bg-(--chat-header-bg) p-3 [&>summary]:cursor-pointer [&>summary]:text-sm [&>summary]:font-medium [&>summary]:text-(--text-secondary) [&>summary]:rounded [&>summary]:focus-visible:ring-2 [&>summary]:focus-visible:ring-(--accent) [&>summary]:min-h-6 max-sm:[&>summary]:min-h-8 [&[open]>summary]:mb-3';
export const automationNotice = 'rounded-lg border border-(--divider) bg-(--chat-header-bg) px-3 py-2.5 text-sm leading-relaxed text-(--text-secondary)';
export const automationDiagnosticsDisclosure = 'text-xs text-(--text-secondary) [&>summary]:cursor-pointer [&>summary]:rounded [&>summary]:focus-visible:ring-2 [&>summary]:focus-visible:ring-(--accent) [&[open]>summary]:mb-2';

export function AutomationField({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <label className={cn('grid min-w-0 gap-1.5 text-xs font-medium text-(--text-secondary)', className)}><span>{label}</span>{children}</label>;
}

/** Forms keep their controls and submitters in one DOM ancestor; only the body scrolls. */
export function AutomationViewport({ children, footer, footerNote }: { children: ReactNode; footer?: ReactNode; footerNote?: ReactNode }) {
  return <>
    <div data-automation-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
      <div className="grid min-w-0 gap-4 text-sm leading-relaxed">{children}</div>
    </div>
    {footer && <footer className="shrink-0 border-t border-(--divider) bg-(--chat-bg) px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
      {footerNote && <div className="mb-2 text-xs leading-relaxed text-(--text-secondary)">{footerNote}</div>}
      <div className="flex flex-wrap items-center gap-2 max-sm:[&>button]:flex-1 max-sm:[&>button:first-child]:basis-full">{footer}</div>
    </footer>}
  </>;
}

export function AutomationFacts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-(--divider) bg-(--chat-header-bg) p-3 sm:grid-cols-3">
    {items.map(item => <div key={item.label} className="min-w-0 last:col-span-2 sm:last:col-span-1">
      <dt className="text-xs text-(--text-secondary)">{item.label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-(--text-primary)">{item.value}</dd>
    </div>)}
  </dl>;
}

export function AutomationTime({ at }: { at: number }) {
  const { language, t } = useI18n();
  if (!Number.isFinite(at)) return <>{t('automation.invalid')}</>;
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={new Intl.DateTimeFormat(language, { dateStyle: 'full', timeStyle: 'long' }).format(date)}>
    {new Intl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' }).format(date)}
  </time>;
}

/** A native invalid field in a closed disclosure must be visible before the browser focuses it. */
export function revealAutomationField(event: SyntheticEvent<HTMLFormElement>) {
  const input = event.target;
  if (!(input instanceof HTMLElement)) return;
  for (let parent = input.parentElement; parent && parent !== event.currentTarget; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
}

/** Compact settings rows keep a visible label beside the editable value and unit. */
export function AutomationSettingRow({ label, children, unit, hint }: { label: string; children: ReactNode; unit?: string; hint?: ReactNode }) {
  return <label className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs text-(--text-secondary)">
    <span>{label}{hint && <span className="mt-1 block text-[11px] font-normal">{hint}</span>}</span>
    <span className="flex min-w-0 items-center gap-2">{children}{unit && <span>{unit}</span>}</span>
  </label>;
}
export const automationNumberField = `${automationField} w-20 px-2 text-right`;
