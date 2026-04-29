'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Star, X, Search, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';
import { useCommandStore } from '@/stores/command-store';
import type { SkillInfo } from '@/hooks/use-skill-picker';
import { useAnchoredPopover } from '@/hooks/use-anchored-popover';
import { useI18n } from '@/lib/i18n';

const EMPTY_COMMANDS: SkillInfo[] = [];
const EMPTY_FAVORITE_SKILLS: string[] = [];

interface PopoverPosition {
  left: number;
  bottom: number;
  maxHeight: number;
}

function calculatePopoverPosition(trigger: HTMLElement): PopoverPosition {
  const rect = trigger.getBoundingClientRect();
  const popoverWidth = 300;
  const padding = 12;
  return {
    left: Math.min(
      Math.max(padding, rect.left),
      window.innerWidth - popoverWidth - padding,
    ),
    bottom: Math.max(padding, window.innerHeight - rect.top + 8),
    maxHeight: Math.max(240, rect.top - 16),
  };
}

interface SkillFavoriteButtonProps {
  sessionId?: string;
  onSelectSkill: (skill: SkillInfo) => void;
}

export function SkillFavoriteButton({ sessionId, onSelectSkill }: SkillFavoriteButtonProps) {
  const { t } = useI18n();
  const favoriteSkills = useSettingsStore((s) => s.settings.favoriteSkills ?? EMPTY_FAVORITE_SKILLS);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const allSkills = useCommandStore((s) => sessionId ? s.commands[sessionId] : undefined) ?? EMPTY_COMMANDS;

  const [isOpen, setIsOpen] = useState(false);
  const [isAddMode, setIsAddMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    setIsAddMode(false);
    setSearchQuery('');
  }, []);
  const { position, updatePosition } = useAnchoredPopover({
    isOpen,
    onClose: close,
    triggerRef,
    containerRef,
    popoverRef: menuRef,
    calculatePosition: calculatePopoverPosition,
  });

  // Autofocus search when add mode opens
  useEffect(() => {
    if (isAddMode) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [isAddMode]);

  const hasFavorites = favoriteSkills.length > 0;

  const handleToggleOpen = useCallback(() => {
    if (!isOpen) {
      updatePosition();
      // No favorites → go straight to add mode
      setIsAddMode(!hasFavorites);
    }
    setIsOpen((v) => !v);
    setSearchQuery('');
  }, [isOpen, updatePosition, hasFavorites]);

  const handleAddFavorite = useCallback(
    (skill: SkillInfo) => {
      if (favoriteSkills.includes(skill.name)) return;
      updateSettings({ favoriteSkills: [...favoriteSkills, skill.name] });
    },
    [favoriteSkills, updateSettings],
  );

  const handleRemoveFavorite = useCallback(
    (skillName: string) => {
      updateSettings({ favoriteSkills: favoriteSkills.filter((n) => n !== skillName) });
    },
    [favoriteSkills, updateSettings],
  );

  const handleExecuteSkill = useCallback(
    (skillName: string) => {
      const skill = allSkills.find((s) => s.name === skillName);
      onSelectSkill(skill ?? { name: skillName, description: '' });
      close();
    },
    [allSkills, onSelectSkill, close],
  );

  // Filter skills for add section (exclude already-favorited)
  const filteredSkills = allSkills.filter((s) => {
    if (favoriteSkills.includes(s.name)) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggleOpen}
        className={cn(
          'inline-flex items-center justify-center w-7 h-7 rounded-full',
          'border border-(--divider) bg-(--input-bg) text-(--text-secondary)',
          'hover:border-(--accent)/40 hover:text-(--accent) hover:bg-(--accent)/8',
          'transition-colors',
          isOpen && 'border-(--accent)/40 text-(--accent) bg-(--accent)/8',
        )}
        title={t('skill.favoriteSkills')}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        data-testid="skill-favorite-trigger"
      >
        <Star className={cn('w-3.5 h-3.5', hasFavorites && 'fill-current')} />
      </button>

      {isOpen && position && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          data-testid="skill-favorite-popover"
          data-side="top"
          className="fixed z-[10001] w-[300px] flex flex-col rounded-xl border border-(--chat-header-border) bg-(--chat-header-bg) shadow-lg shadow-black/10"
          style={{
            left: position.left,
            bottom: position.bottom,
            maxHeight: Math.min(position.maxHeight, 400),
          }}
        >
          {/* Favorites section (top, farther from button) */}
          {hasFavorites && (
            <div className="flex flex-col">
              <div className="px-3 pt-2.5 pb-1.5">
                <span className="text-[11px] font-medium text-(--text-muted) uppercase tracking-wider">
                  {t('skill.favorites')}
                </span>
              </div>
              <div className="overflow-y-auto max-h-[180px]">
                {favoriteSkills.map((skillName) => (
                  <div
                    key={skillName}
                    className={cn(
                      'group flex items-center gap-2 px-3 py-1.5',
                      'hover:bg-(--accent)/6 transition-colors',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleExecuteSkill(skillName)}
                      className="flex-1 text-left text-sm font-mono text-(--accent) truncate"
                    >
                      /{skillName}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveFavorite(skillName)}
                      className={cn(
                        'shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full',
                        'text-(--text-muted) opacity-0 group-hover:opacity-100',
                        'hover:bg-(--error)/15 hover:text-(--error)',
                        'transition-all duration-150',
                      )}
                      title={t('skill.removeFavorite')}
                      aria-label={t('skill.removeFavorite')}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add button / Search section (bottom, closest to button) */}
          {!isAddMode ? (
            <button
              type="button"
              onClick={() => setIsAddMode(true)}
              className={cn(
                'flex items-center justify-center gap-1.5 px-3 py-2',
                'text-xs text-(--text-muted)',
                hasFavorites && 'border-t border-(--divider)',
                'hover:bg-(--accent)/6 hover:text-(--accent)',
                'transition-colors',
              )}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('skill.addSkill')}</span>
            </button>
          ) : (
            <div className={cn('flex flex-col flex-1 min-h-0', hasFavorites && 'border-t border-(--divider)')}>
              <div className="p-2.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-muted)" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        if (hasFavorites) {
                          setIsAddMode(false);
                          setSearchQuery('');
                        } else {
                          close();
                        }
                      }
                    }}
                    placeholder={t('skill.searchPlaceholder')}
                    className={cn(
                      'w-full pl-8 pr-3 py-1.5 rounded-lg text-sm',
                      'bg-(--input-bg) text-(--input-text)',
                      'border border-(--input-border)',
                      'placeholder:text-(--input-placeholder)',
                      'focus:outline-none focus:border-(--accent)/50',
                      'transition-colors',
                    )}
                  />
                </div>
              </div>

              <div className="overflow-y-auto flex-1 max-h-[200px]">
                {filteredSkills.length === 0 ? (
                  <div className="px-3 py-4 text-center text-sm text-(--text-muted)">
                    {searchQuery ? t('skill.noSearchResults') : t('skill.noAvailableSkills')}
                  </div>
                ) : (
                  filteredSkills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => handleAddFavorite(skill)}
                      className={cn(
                        'w-full text-left px-3 py-2 flex items-center gap-2',
                        'transition-colors duration-75',
                        'border-b border-(--divider)/40 last:border-b-0',
                        'hover:bg-(--accent)/6',
                      )}
                    >
                      <Star className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-mono text-(--accent)">
                          /{skill.name}
                        </span>
                        {skill.description && (
                          <p className="text-xs text-(--text-muted) line-clamp-1 mt-0.5">
                            {skill.description}
                          </p>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
