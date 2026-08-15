import type { PermissionMode } from '@/lib/ws/message-types';
import type { ShortcutId } from '@/lib/keyboard/registry';
import type { ProviderSessionAccessMode, ProviderSessionMode } from '@/lib/session/session-control-types';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';

/** Surface a PTY session opens on: its terminal, or the read-only chat view. */
export type TerminalSessionDefaultView = 'terminal' | 'chat';

/** Which kind of session the creation UIs preselect: a plain chat, or a worktree task. */
export type NewSessionDefaultKind = 'chat' | 'task';
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
  sourceControlAi: {
    provider: string;
    /** Empty means the provider CLI's default model. */
    model?: string;
  };
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
  /**
   * Which surface a terminal (PTY) session opens on when it has no per-session
   * preference yet. Distinct from `agentExecutionMode`, which decides what kind
   * of session gets created; this only picks the view for one that already is a
   * PTY session. Defaults to the terminal — the PTY is what those sessions are
   * for, and the chat view is a read-only lens over the same conversation.
   */
  terminalSessionDefaultView: TerminalSessionDefaultView;
  /**
   * Which entry the session creation UIs (empty panel, quick-create sheet) start
   * on. Orthogonal to `agentExecutionMode`: this picks chat vs. worktree task,
   * not PTY vs. GUI. Places that derive the kind from their own context — the
   * Kanban board's per-column create button — keep overriding it.
   */
  defaultNewSessionKind: NewSessionDefaultKind;
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
  /** Model IDs manually added when a provider CLI does not list them. */
  providerCustomModels: Record<string, string[]>;
  inactivePanelDimming: number;
  showProviderIcons: boolean;
  showRecentWork: boolean;
  /** How selecting a session card behaves while the Kanban board is active. */
  kanbanSessionOpenMode: KanbanSessionOpenMode;
  sttEngine: SttEngine;
  geminiApiKey: string;
  favoriteSkills: string[];
  agentEnvironment: AgentEnvironment;
  /** Inject Tessera's session-scoped control skill into managed GUI and PTY CLIs. */
  tesseraCliEnabled: boolean;
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
