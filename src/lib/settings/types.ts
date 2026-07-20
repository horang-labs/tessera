import type { PermissionMode } from '@/lib/ws/message-types';
import type { ShortcutId } from '@/lib/keyboard/registry';
import type { GitActionId } from '@/lib/git/action-templates';
import type { ProviderSessionAccessMode, ProviderSessionMode } from '@/lib/session/session-control-types';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import type {
  TerminalDarkThemePresetId,
  TerminalLightThemePresetId,
} from '@/lib/terminal/terminal-theme';

export type Language = 'en' | 'ko' | 'zh' | 'ja';
export type Theme = 'light' | 'dark' | 'auto';
export type EnterKeyBehavior = 'send' | 'newline';
export type SttEngine = 'webSpeech' | 'gemini';
export type AgentEnvironment = 'native' | 'wsl';
export type WindowsCloseBehavior = 'ask' | 'tray' | 'quit';
export type KanbanSessionOpenMode = 'split' | 'peek';
export type CliCommandOverrides = Record<string, Partial<Record<AgentEnvironment, string>>>;

export interface SetupState {
  dismissedAt: string | null;
  completedAt: string | null;
}

export interface GitConfig {
  branchPrefix: string;
  /** Prepended to every git action prompt. Single shared "tone/policy" layer. */
  globalGuidelines: string;
  /** Per-action prompt overrides. Missing or empty entry → default template. */
  actionTemplates: Partial<Record<GitActionId, string>>;
}

export interface ProviderSessionDefaults {
  model?: string;
  reasoningEffort?: string | null;
  /** Codex service-tier preference. `default` is an explicit Fast opt-out. */
  serviceTier?: string | null;
  sessionMode?: ProviderSessionMode;
  accessMode?: ProviderSessionAccessMode;
  /** Claude Code high-speed serving toggle. Defaults off (opt-in; uses more credits). */
  fastMode?: boolean | null;
}

export interface UserProfileSettings {
  displayName: string;
  avatarDataUrl: string;
}

export interface TelemetrySettings {
  enabled: boolean;
}

export interface UserSettings {
  language: Language;
  /** Preferred interaction surface for newly created agent sessions. */
  agentExecutionMode: AgentExecutionMode;
  profile: UserProfileSettings;
  notifications: {
    soundEnabled: boolean;
    showToast: boolean;
    /** Optional LLM replacement for the deterministic title shown immediately. */
    aiTitleRefinement: boolean;
  };
  translate: {
    enabled: boolean;
    sourceLanguage: Language;
    targetLanguage: Language;
    /** Per-direction provider + model + custom prompt template ({{source}}/{{target}}/{{text}}; '' = default). */
    input: { provider: string; model?: string; promptTemplate?: string };
    output: { provider: string; model?: string; promptTemplate?: string };
    /** Keyboard shortcut for "translate & send" (e.g. 'alt+enter'). */
    sendShortcut: string;
  };
  theme: Theme;
  terminalThemeLightPreset: TerminalLightThemePresetId;
  terminalThemeDarkPreset: TerminalDarkThemePresetId;
  fontSize: number;
  enterKeyBehavior: EnterKeyBehavior;
  defaultPermissionMode: PermissionMode;
  /** Legacy Claude-only default model, kept for backward compatibility. */
  defaultModel: string;
  providerDefaults: Record<string, ProviderSessionDefaults>;
  inactivePanelDimming: number;
  showProviderIcons: boolean;
  showRecentWork: boolean;
  /** How selecting a session card behaves while the Kanban board is active. */
  kanbanSessionOpenMode: KanbanSessionOpenMode;
  sttEngine: SttEngine;
  geminiApiKey: string;
  favoriteSkills: string[];
  agentEnvironment: AgentEnvironment;
  cliCommandOverrides: CliCommandOverrides;
  windowsCloseBehavior: WindowsCloseBehavior;
  setup: SetupState;
  telemetry: TelemetrySettings;
  autoDeleteArchivedWorktrees: boolean;
  archivedWorktreeRetentionDays: number;
  /**
   * Optional absolute worktree path template. Empty string keeps the automatic
   * environment-aware Tessera managed root.
   */
  managedWorktreePathTemplate: string;
  /** User-customized keyboard shortcuts. Empty string = disabled. Missing key = use default. */
  shortcutOverrides: Partial<Record<ShortcutId, string>>;
  gitConfig: GitConfig;
  version: string;
  lastModified: string;
}
