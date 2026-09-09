'use client';

import { useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}

interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'> {
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
}

/** The popover stays in the caller's DOM subtree while painting above clipped sheets. */
export function Select({ value, options, onValueChange, placeholder, searchPlaceholder, emptyLabel,
  className, disabled, id, ...buttonProps }: SelectProps) {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-options`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = options.find((option) => option.value === value);
  const matches = options.filter((option) => `${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const close = (restoreFocus = false) => {
    popupRef.current?.hidePopover();
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    const popup = popupRef.current;
    const trigger = triggerRef.current;
    if (!open || disabled || !popup || !trigger) {
      popup?.hidePopover();
      return;
    }
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upwards = below < 240 && above > below;
      popup.style.width = `${Math.min(rect.width, window.innerWidth - 24)}px`;
      popup.style.maxHeight = `${Math.max(0, Math.min(360, upwards ? above : below))}px`;
      popup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 12))}px`;
      popup.style.top = `${upwards ? Math.max(12, rect.top - popup.offsetHeight - 6) : rect.bottom + 6}px`;
    };
    popup.showPopover();
    position();
    if (searchPlaceholder) searchRef.current?.focus({ preventScroll: true });
    else (popup.querySelector<HTMLElement>('[aria-selected="true"]')
      ?? popup.querySelector<HTMLElement>('[role="option"]'))?.focus({ preventScroll: true });
    popup.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    const observer = new ResizeObserver(position);
    observer.observe(popup);
    window.addEventListener('resize', position);
    // Scroll inside the menu must not move its anchor.
    const onScroll = (event: Event) => { if (!popup.contains(event.target as Node)) position(); };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, disabled, searchPlaceholder]);

  return (
    <div className="min-w-0" data-custom-select>
      <button
        {...buttonProps}
        id={id}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => { if (open) close(); else { setSearch(''); setOpen(true); } }}
        onKeyDown={(event) => {
          if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); setSearch(''); setOpen(true);
          }
        }}
        className={cn('flex w-full min-w-0 items-center gap-2 rounded-xl border border-(--divider) bg-(--input-bg) px-3 py-2.5 text-left text-sm text-(--text-primary) outline-none transition-colors hover:border-(--text-muted)/50 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent)/20 disabled:cursor-not-allowed disabled:opacity-60', className)}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-(--text-muted) transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <div
        ref={popupRef}
        popover="auto"
        onToggle={(event) => { if (event.newState === 'closed') setOpen(false); }}
        className="fixed inset-auto m-0 overflow-hidden rounded-xl border border-(--divider) bg-(--input-bg) p-0 text-(--text-primary) shadow-[0_12px_36px_rgba(0,0,0,0.4)]"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
          if (event.key === 'Tab') { close(true); return; }
          const rows = Array.from(popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
          if (!rows.length) return;
          const index = rows.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
            rows[next].focus();
          }
          if (index >= 0 && (event.key === 'Home' || event.key === 'End')) {
            event.preventDefault(); rows[event.key === 'Home' ? 0 : rows.length - 1].focus();
          }
        }}
      >
        {open && <div className="flex max-h-[inherit] flex-col">
          {searchPlaceholder && <div className="flex shrink-0 items-center gap-2 border-b border-(--divider) px-3">
            <Search className="h-3.5 w-3.5 text-(--text-muted)" aria-hidden="true" />
            <input ref={searchRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)} aria-label={searchPlaceholder} placeholder={searchPlaceholder} className="min-w-0 flex-1 bg-transparent py-2.5 text-xs outline-none placeholder:text-(--text-muted)" />
          </div>}
          <div id={listId} role="listbox" aria-label={buttonProps['aria-label'] ?? placeholder ?? selected?.label} className="min-h-0 overflow-y-auto overscroll-contain p-1">
            {matches.map((option, index) => <div key={option.value} role="presentation">
              {option.group && option.group !== matches[index - 1]?.group && <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-(--text-muted)">{option.group}</div>}
              <button type="button" role="option" aria-selected={option.value === value} tabIndex={-1}
                onClick={() => { onValueChange(option.value); close(true); }}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs outline-none hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover)', option.value === value && 'bg-(--accent)/10 text-(--accent-hover)')}>
                <span className="min-w-0 flex-1"><span className="block truncate" title={option.label}>{option.label}</span>{option.description && <span className="mt-0.5 block truncate font-mono text-[10px] text-(--text-muted)" title={option.description}>{option.description}</span>}</span>
                {option.value === value && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              </button>
            </div>)}
            {!matches.length && <p className="px-3 py-5 text-center text-xs text-(--text-muted)" role="status">{emptyLabel}</p>}
          </div>
        </div>}
      </div>
    </div>
  );
}
