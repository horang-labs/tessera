'use client';

import { useCallback, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useAnchoredPopover } from '@/hooks/use-anchored-popover';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import { ANCHORED_VIEWPORT_MARGIN } from '@/lib/ui/anchored-viewport';
import { PHONE_TOUCH_TARGET_HEIGHT } from '@/lib/ui/touch-target';
import type { SettingsSectionId } from '@/stores/settings-store';

/** Distance kept between the trigger and the list below it. */
const PICKER_GAP = 4;

interface PickerPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export interface SettingsSection {
  id: SettingsSectionId;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

export interface SettingsSectionPickerProps {
  sections: SettingsSection[];
  activeId: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}

/**
 * The Phone viewport stand-in for the Settings dialog's section strip (#264).
 *
 * At 360px the strip held 1029px of tabs in a 332px box: two pages on screen,
 * five off it behind a horizontal scrub nothing advertised — Remote access and
 * Models among them, which are the pages someone opens *because* they are on a
 * phone.
 *
 * Wrapping the strip onto rows was measured first and rejected on height: four
 * rows cost 333px of a dialog that is only 698px tall once the phone's own
 * chrome is out of the way, leaving the page body 98px. That trades a
 * navigation defect for an unusable body. This is one row instead — a 44-55px
 * trigger in a 111px band, against the wrap's 333px — and it names the page you
 * are on, so the body keeps the room it had.
 *
 * The sections, their order and their names are the panel's; this only presents
 * them.
 */
export default function SettingsSectionPicker({
  sections,
  activeId,
  onSelect,
}: SettingsSectionPickerProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  const calculatePosition = useCallback((trigger: HTMLElement): PickerPosition => {
    const rect = trigger.getBoundingClientRect();
    const top = rect.bottom + PICKER_GAP;

    // The trigger spans the dialog, which is already inside the viewport with a
    // margin on both sides, so matching it needs no clamp of its own. Only the
    // height has to be bounded: the list is as tall as the screen below the
    // trigger allows.
    return {
      top,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(0, window.innerHeight - top - ANCHORED_VIEWPORT_MARGIN),
    };
  }, []);

  const { position } = useAnchoredPopover<PickerPosition>({
    isOpen,
    onClose: close,
    triggerRef,
    containerRef,
    popoverRef,
    calculatePosition,
  });

  // `capture` on purpose: the panel closes the whole dialog on Escape from a
  // window listener, and Escape with the list open means "close the list".
  useCloseOnEscape(close, { enabled: isOpen, capture: true });

  const handleMenuKeyDown = useMenuNavigation(popoverRef);

  const activeSection = sections.find((section) => section.id === activeId) ?? sections[0];
  if (!activeSection) return null;
  const ActiveIcon = activeSection.icon;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={cn(
          'flex w-full items-center gap-3 rounded-2xl border border-(--divider) bg-(--input-bg)/80 px-3 py-2 text-left',
          PHONE_TOUCH_TARGET_HEIGHT,
          'text-(--sidebar-text-active) transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)',
          isOpen && 'bg-(--sidebar-hover)',
        )}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t('settings.sectionPicker')}
        data-testid="settings-section-picker"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-(--divider) bg-(--input-bg)/75 text-(--text-primary)">
          <ActiveIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-(--text-muted)">
            {t('settings.sectionPicker')}
          </span>
          <span className="block truncate text-sm font-medium text-(--text-primary)">
            {activeSection.label}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-(--text-secondary) transition-transform',
            isOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {/* Portalled, like the tab list's popover: the dialog is `overflow-hidden`
          and a list rendered inside it would be clipped the moment anything up
          the tree gained a transform. */}
      {isOpen && position && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popoverRef}
          role="menu"
          aria-label={t('settings.sectionPicker')}
          className={cn(
            'fixed z-[9999] overflow-y-auto rounded-2xl border border-(--divider) p-1.5',
            'bg-(--sidebar-bg)',
            'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
          )}
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          onKeyDown={handleMenuKeyDown}
          data-testid="settings-section-picker-list"
        >
          {sections.map((section) => {
            const Icon = section.icon;
            const isActive = section.id === activeId;

            return (
              <button
                key={section.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsOpen(false);
                  onSelect(section.id);
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left',
                  PHONE_TOUCH_TARGET_HEIGHT,
                  'transition-colors focus:outline-none',
                  isActive
                    ? 'bg-(--sidebar-active) text-(--sidebar-text-active)'
                    : 'text-(--sidebar-text) hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover)',
                )}
                aria-current={isActive ? 'page' : undefined}
                data-testid={`settings-nav-${section.id}`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 break-words text-sm font-medium">
                  {section.label}
                </span>
                {isActive ? (
                  <Check className="h-4 w-4 shrink-0 text-(--accent)" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
