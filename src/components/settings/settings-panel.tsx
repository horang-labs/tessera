'use client';

import { useEffect, useCallback, useState, type ReactNode } from 'react';
import { GitBranch, Palette, SlidersHorizontal, Terminal, X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import ProfileSettings from './profile-settings';
import LanguageSwitcher from './language-switcher';
import NotificationSettings from './notification-settings';
import TelemetrySettings from './telemetry-settings';
import UpdateSettings from './update-settings';
import KeyboardSettings from './keyboard-settings';
import WindowBehaviorSettings from './window-behavior-settings';
import AppearanceSettings from './appearance-settings';
import AgentEnvironmentSettings from './agent-environment-settings';
import WorktreeSettings from './worktree-settings';
import CliStatusList from './cli-status-list';
import ToolStatusList from './tool-status-list';
import GitSettings from './git-settings';
// import SttSettings from './stt-settings'; // Gemini STT 설정 — 당분간 비활성화
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useElectronPlatform } from '@/hooks/use-electron-platform';

type SettingsSectionId = 'general' | 'appearance' | 'development' | 'git';

function SettingsCard({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-(--divider) bg-(--input-bg)/80 p-4 shadow-[0_8px_20px_rgba(15,23,42,0.04)] md:p-5',
        className
      )}
      data-testid={testId}
    >
      {children}
    </section>
  );
}

export default function SettingsPanel() {
  const { t } = useI18n();
  const isOpen = useSettingsStore((state) => state.isOpen);
  const closeSettings = useSettingsStore((state) => state.close);
  const isWindowsServer = useSettingsStore((state) => state.serverHostInfo?.isWindowsEcosystem ?? false);
  const electronPlatform = useElectronPlatform();
  const isWindowsElectron = electronPlatform === 'win32';
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSettings();
      }
    },
    [closeSettings]
  );

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  const sections = [
    {
      id: 'general' as const,
      icon: SlidersHorizontal,
      label: t('settings.sections.general'),
      description: t('settings.sections.generalDesc'),
    },
    {
      id: 'appearance' as const,
      icon: Palette,
      label: t('settings.sections.appearance'),
      description: t('settings.sections.appearanceDesc'),
    },
    {
      id: 'development' as const,
      icon: Terminal,
      label: t('settings.sections.development'),
      description: t('settings.sections.developmentDesc'),
    },
    {
      id: 'git' as const,
      icon: GitBranch,
      label: t('settings.sections.git'),
      description: t('settings.sections.gitDesc'),
    },
  ];

  const currentSection = sections.find((section) => section.id === activeSection) ?? sections[0];

  if (!isOpen) return null;
  if (!currentSection) return null;

  function renderSectionContent(sectionId: SettingsSectionId) {
    switch (sectionId) {
      case 'appearance':
        return (
          <SettingsCard testId="settings-section-appearance">
            <AppearanceSettings />
          </SettingsCard>
        );
      case 'git':
        return (
          <SettingsCard testId="settings-section-git">
            <GitSettings />
          </SettingsCard>
        );
      case 'development':
        return (
          <>
            <SettingsCard testId="settings-section-development-cli-status">
              <h3 className="font-medium text-(--text-primary)">
                {t('settings.cliStatus.title')}
              </h3>
              <div className="mt-2">
                <CliStatusList />
              </div>
              <div className="mt-4 border-t border-(--divider) pt-4">
                <ToolStatusList />
              </div>
              <p className="mt-2 text-xs text-(--text-muted)">
                {t('settings.cliStatus.description')}
              </p>
            </SettingsCard>
            {isWindowsServer && (
              <SettingsCard testId="settings-section-development-environment">
                <AgentEnvironmentSettings isWindowsServer={isWindowsServer} />
              </SettingsCard>
            )}
            <SettingsCard testId="settings-section-development-worktrees">
              <WorktreeSettings />
            </SettingsCard>
          </>
        );
      case 'general':
      default:
        return (
          <>
            <SettingsCard testId="settings-section-general-profile">
              <ProfileSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-language">
              <LanguageSwitcher />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-notifications">
              <NotificationSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-updates">
              <UpdateSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-telemetry">
              <TelemetrySettings />
            </SettingsCard>
            {isWindowsElectron && (
              <SettingsCard testId="settings-section-general-window-behavior">
                <WindowBehaviorSettings />
              </SettingsCard>
            )}
            <SettingsCard testId="settings-section-general-shortcuts">
              <KeyboardSettings />
            </SettingsCard>
          </>
        );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4"
      onClick={closeSettings}
      data-testid="settings-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="mx-1 flex h-[min(90vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-(--divider) bg-(--sidebar-bg) shadow-[0_20px_54px_rgba(15,23,42,0.24)] md:mx-4 md:flex-row"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-modal"
      >
        <aside className="shrink-0 border-b border-(--divider) bg-[linear-gradient(180deg,rgba(255,255,255,0.18),rgba(255,255,255,0.03))] md:w-64 md:border-b-0 md:border-r">
          <div className="px-4 pb-3 pt-4 md:px-5 md:pb-4 md:pt-6">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-(--text-muted)">
              {t('settings.title')}
            </p>
          </div>
          <ScrollArea className="md:h-[calc(90vh-96px)]">
            <nav
              className="flex gap-2 px-3 pb-4 md:flex-col md:px-4 md:pb-6"
              aria-label="Settings sections"
            >
              {sections.map((section) => {
                const Icon = section.icon;
                const isActive = currentSection.id === section.id;

                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={cn(
                      'flex min-w-[140px] items-center gap-3 rounded-2xl px-3 py-3 text-left transition-all md:min-w-0',
                      isActive
                        ? 'bg-(--sidebar-active) text-(--sidebar-text-active) shadow-[inset_0_0_0_1px_rgba(255,255,255,0.4)]'
                        : 'text-(--sidebar-text) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)'
                    )}
                    aria-pressed={isActive}
                    data-testid={`settings-nav-${section.id}`}
                  >
                    <span
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border',
                        isActive
                          ? 'border-(--divider) bg-(--input-bg)/75 text-(--text-primary)'
                          : 'border-transparent bg-(--chat-bg)/70 text-(--text-muted)'
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{section.label}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </ScrollArea>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-(--divider) bg-(--input-bg)/45 px-5 py-5 md:px-7 md:py-6">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-(--text-muted)">
                {currentSection.label}
              </p>
              <h2 id="settings-title" className="text-2xl font-bold text-(--text-primary)">
                {t('settings.title')}
              </h2>
              <p className="max-w-2xl text-sm leading-6 text-(--text-secondary)">
                {currentSection.description}
              </p>
            </div>
            <button
              onClick={closeSettings}
              aria-label="Close settings"
              className="rounded-xl p-2 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              data-testid="settings-close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-5 py-5 md:px-7 md:py-6" data-testid="settings-content">
            <div className="space-y-4">
              {renderSectionContent(currentSection.id)}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
