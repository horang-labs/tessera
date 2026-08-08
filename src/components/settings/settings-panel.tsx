'use client';

import { useEffect, useCallback, useState, type ReactNode } from 'react';
import { Cpu, FolderGit2, GitBranch, MessageSquarePlus, Palette, RadioTower, SlidersHorizontal, Terminal, X } from 'lucide-react';
import {
  useSettingsStore,
  type SettingsSectionId as SettingsStoreSectionId,
} from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import ProfileSettings from './profile-settings';
import LanguageSwitcher from './language-switcher';
import NotificationSettings from './notification-settings';
import TranslateSettings from './translate-settings';
import TelemetrySettings from './telemetry-settings';
import UpdateSettings from './update-settings';
import KeyboardSettings from './keyboard-settings';
import WindowBehaviorSettings from './window-behavior-settings';
import AppearanceSettings from './appearance-settings';
import AgentEnvironmentSettings from './agent-environment-settings';
import CliCommandOverrideSettings from './cli-command-override-settings';
import WorktreeSettings from './worktree-settings';
import CliStatusList from './cli-status-list';
import CliDiagnosticsPanel from './cli-diagnostics-panel';
import ToolStatusList from './tool-status-list';
import GitSettings from './git-settings';
import AgentExecutionModeSettings from './agent-execution-mode-settings';
import TerminalViewDefaultSettings from './terminal-view-default-settings';
import NewSessionKindSettings from './new-session-kind-settings';
import CustomModelSettings from './custom-model-settings';
import ProjectPreparationSettings from './project-preparation-settings';
import RemoteAccessSection from './remote-access-section';
import SettingsSectionPicker from './settings-section-picker';
// import SttSettings from './stt-settings'; // Gemini STT 설정 — 당분간 비활성화
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { PHONE_TOUCH_TARGET } from '@/lib/ui/touch-target';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { usePhoneViewport } from '@/hooks/use-phone-viewport';
import { FeedbackDialog } from '@/components/feedback/feedback-dialog';

// Defined with the store, because opening the panel is how a caller asks for a
// section and the store is what carries the ask.
type SettingsSectionId = SettingsStoreSectionId;

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
  const isSaving = useSettingsStore((state) => state.pendingSaveCount > 0);
  const isWindowsServer = useSettingsStore((state) => state.serverHostInfo?.isWindowsEcosystem ?? false);
  const electronPlatform = useElectronPlatform();
  const isWindowsElectron = electronPlatform === 'win32';
  const isPhoneViewport = usePhoneViewport();
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);

  // Whoever opened the panel may have said where to land. Their ask holds until
  // the user navigates, and a fresh ask clears whatever they navigated to —
  // opening the panel at a section has to arrive there every time.
  const requestedSection = useSettingsStore((state) => state.openRequest?.section);
  const [chosenSection, setChosenSection] = useState<SettingsSectionId | null>(null);
  const [answeredRequest, setAnsweredRequest] = useState(requestedSection);
  if (requestedSection !== answeredRequest) {
    setAnsweredRequest(requestedSection);
    setChosenSection(null);
  }
  const activeSection: SettingsSectionId = chosenSection ?? requestedSection ?? 'general';
  const setActiveSection = setChosenSection;

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
      id: 'project' as const,
      icon: FolderGit2,
      label: t('settings.sections.project'),
      description: t('settings.sections.projectDesc'),
    },
    {
      id: 'appearance' as const,
      icon: Palette,
      label: t('settings.sections.appearance'),
      description: t('settings.sections.appearanceDesc'),
    },
    {
      id: 'models' as const,
      icon: Cpu,
      label: t('settings.sections.models'),
      description: t('settings.sections.modelsDesc'),
    },
    {
      id: 'remote-access' as const,
      icon: RadioTower,
      label: t('settings.sections.remoteAccess'),
      description: t('settings.sections.remoteAccessDesc'),
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
      case 'project':
        return (
          <SettingsCard testId="settings-section-project-preparation">
            <ProjectPreparationSettings />
          </SettingsCard>
        );
      case 'git':
        return (
          <SettingsCard testId="settings-section-git">
            <GitSettings />
          </SettingsCard>
        );
      case 'models':
        return (
          <SettingsCard testId="settings-section-models">
            <CustomModelSettings />
          </SettingsCard>
        );
      case 'remote-access':
        return (
          <SettingsCard testId="settings-section-remote-access">
            <RemoteAccessSection />
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
              <div className="mt-4 border-t border-(--divider) pt-4">
                <CliDiagnosticsPanel />
              </div>
            </SettingsCard>
            {isWindowsServer && (
              <SettingsCard testId="settings-section-development-environment">
                <AgentEnvironmentSettings isWindowsServer={isWindowsServer} />
              </SettingsCard>
            )}
            <SettingsCard testId="settings-section-development-cli-overrides">
              <CliCommandOverrideSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-development-worktrees">
              <WorktreeSettings />
            </SettingsCard>
          </>
        );
      case 'general':
      default:
        return (
          <>
            <SettingsCard testId="settings-section-general-execution-mode">
              <AgentExecutionModeSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-new-session-kind">
              <NewSessionKindSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-terminal-view">
              <TerminalViewDefaultSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-profile">
              <ProfileSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-language">
              <LanguageSwitcher />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-notifications">
              <NotificationSettings />
            </SettingsCard>
            <SettingsCard testId="settings-section-general-translate">
              <TranslateSettings />
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
    <>
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
            {/* At the Phone viewport the strip below is 1029px of tabs in a 332px
                box, so five of the seven pages sat off-screen behind a scroll
                nothing advertised (#264). One control lists them all and costs
                the dialog a single row. */}
            {isPhoneViewport ? (
              <div className="px-3 pb-3">
                <SettingsSectionPicker
                  sections={sections}
                  activeId={currentSection.id}
                  onSelect={setActiveSection}
                />
              </div>
            ) : (
            <ScrollArea className="md:h-[calc(90vh-96px)]">
              <nav
                className="flex gap-2 px-3 pb-4 md:flex-col md:px-4 md:pb-6"
                aria-label="Settings sections"
                data-testid="settings-nav"
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
            )}
          </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* At 360px these two buttons sat beside the text and squeezed its column
              to 96px at the default font scale and to nothing at all at the largest,
              so the description wrapped one word to a line and the block took 265px,
              then 463px, of a 698px dialog — more than the nav and the body together
              (#267). Below the Phone viewport step the buttons take the first row
              beside the section name, the description gets the dialog's full width,
              and the "Settings" heading — which the sidebar already prints two rows
              above — stays only as the dialog's accessible name. Grid rather than
              flex so both arrangements are the same DOM: above the step the buttons
              span all three rows, which is the top-right corner they have always
              had. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-b border-(--divider) bg-(--input-bg)/45 px-5 py-3 sm:py-5 md:px-7 md:py-6">
            <p className="col-start-1 row-start-1 self-center text-xs font-semibold uppercase tracking-[0.18em] text-(--text-muted) sm:self-start">
              {currentSection.label}
            </p>
            <h2
              id="settings-title"
              className="col-start-1 row-start-2 text-2xl font-bold text-(--text-primary) max-sm:sr-only"
            >
              {t('settings.title')}
            </h2>
            <p className="col-span-2 row-start-2 max-w-2xl text-sm leading-6 text-(--text-secondary) sm:col-span-1 sm:col-start-1 sm:row-start-3">
              {currentSection.description}
            </p>
            <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-2 sm:row-span-3">
              <button
                type="button"
                onClick={() => setIsFeedbackOpen(true)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-xl border border-(--divider) px-3 py-2 text-xs font-medium text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
                  // The label is what collapses, so the hit area has to be
                  // restated: a bare icon at px-3 is 40px across, under the 44px
                  // the same wave gave every other phone control (#259).
                  PHONE_TOUCH_TARGET,
                )}
                data-testid="settings-feedback"
              >
                <MessageSquarePlus className="h-4 w-4" />
                <span className="max-sm:sr-only">{t('feedback.settingsCta')}</span>
              </button>
              <button
                onClick={closeSettings}
                disabled={isSaving}
                aria-label="Close settings"
                className={cn(
                  'rounded-xl p-2 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-wait disabled:opacity-50',
                  // Free here, and only here: the row is already 44px tall for the
                  // collapsed button beside it, so the floor costs the block no
                  // height at any scale — it just stops the pair looking mismatched.
                  PHONE_TOUCH_TARGET,
                )}
                data-testid="settings-close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-5 py-5 md:px-7 md:py-6" data-testid="settings-content">
            <div className="space-y-4">
              {renderSectionContent(currentSection.id)}
            </div>
          </ScrollArea>
        </div>
      </div>
      </div>
      {isFeedbackOpen && (
        <FeedbackDialog source="settings" onClose={() => setIsFeedbackOpen(false)} />
      )}
    </>
  );
}
