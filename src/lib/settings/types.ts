import type { PermissionMode } from '@/lib/ws/message-types';
import type { ShortcutId } from '@/lib/keyboard/registry';
import type { GitActionId } from '@/lib/git/action-templates';
import type { ProviderSessionAccessMode, ProviderSessionMode } from '@/lib/session/session-control-types';

export type Language = 'en' | 'ko' | 'zh' | 'ja';
export type Theme = 'light' | 'dark' | 'auto';
export type EnterKeyBehavior = 'send' | 'newline';
export type SttEngine = 'webSpeech' | 'gemini';
export type AgentEnvironment = 'native' | 'wsl';
export type WindowsCloseBehavior = 'ask' | 'tray' | 'quit';
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
  sessionMode?: ProviderSessionMode;
  accessMode?: ProviderSessionAccessMode;
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
  profile: UserProfileSettings;
  notifications: {
    soundEnabled: boolean;
    showToast: boolean;
    autoGenerateTitle: boolean;
  };
  theme: Theme;
  fontSize: number;
  enterKeyBehavior: EnterKeyBehavior;
  defaultPermissionMode: PermissionMode;
  /** Legacy Claude-only default model, kept for backward compatibility. */
  defaultModel: string;
  providerDefaults: Record<string, ProviderSessionDefaults>;
  inactivePanelDimming: number;
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
