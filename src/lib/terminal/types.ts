import type {
  TerminalAppearanceChangePolicy,
  TerminalInterruptInputPolicy,
  TerminalResizeScrollbackPolicy,
} from '@/lib/cli/providers/types';

export type TerminalShellKind = 'default' | 'cmd' | 'powershell' | 'wsl';

export type TerminalColorSchemeMode = 'light' | 'dark';

export interface TerminalAppearance {
  mode: TerminalColorSchemeMode;
  foreground: string;
  background: string;
}

/** Client-safe request. Executable, argv, and provider conversation ids are server-owned. */
export type TerminalLaunchIntent =
  | { kind: 'claude-slash'; commandInput: string }
  | { kind: 'codex-slash'; commandInput: string };

/** Server-resolved launch plan. Never accepted from a browser transport. */
export interface TerminalLaunchSpec {
  program?: string;
  args?: string[];
  /** Server-resolved session workspace. Browser-provided cwd is ignored for launch intents. */
  cwd?: string;
  /** Type a complete shell command without submitting it. */
  shellPrefillArgv?: { program: string; args: string[] };
  /** Type into the launched TUI without submitting it. */
  prefillInput?: string;
  /** Session whose app-server ownership was handed to this terminal. */
  handoffSessionId?: string;
}

export interface TerminalCreateOptions {
  terminalId: string;
  userId: string;
  connectionId: string;
  surfaceId: string;
  /** Token that may conditionally release a runtime created by a transient preview. */
  previewOwnerToken?: string;
  cwd?: string | null;
  sessionId?: string | null;
  shellKind?: TerminalShellKind;
  cols?: number;
  rows?: number;
  launchSpec?: TerminalLaunchSpec;
  /** Provider hook side-channel token minted by server-message-routing. */
  paneToken?: string;
  /** Native agent provider launched inside this PTY. */
  providerId?: string;
  /** Provider-declared behavior for light/dark changes in an already-running TUI. */
  appearanceChangePolicy?: TerminalAppearanceChangePolicy;
  /** Provider-declared handling for ED3 emitted by a resize redraw. */
  resizeScrollbackPolicy?: TerminalResizeScrollbackPolicy;
  /** Provider-declared input gesture that interrupts an active terminal turn. */
  interruptInputPolicy?: TerminalInterruptInputPolicy;
  /** Whether closing this runtime can be followed by a same-session resume. */
  canRestartForAppearance?: () => boolean;
  /** Revalidated client-safe recipe for recreating a handoff runtime after exit. */
  appearanceRestartIntent?: TerminalLaunchIntent;
  /** Renderer-resolved appearance advertised to terminal applications. */
  appearance?: TerminalAppearance;
  /** Disposes provider resources created before PTY spawn. */
  launchObserverDisposer?: () => void;
  /** Server-owned environment overrides for the provider process. */
  launchEnv?: Record<string, string>;
  /**
   * Async variant of launchEnv, resolved inside the opening window right before
   * PTY spawn. Slow preparation (e.g. the WSL guest Codex overlay, up to tens of
   * seconds on a cold VM) must use this instead of awaiting before create():
   * outside the opening window a concurrent close_session cannot cancel it and
   * a duplicate terminal_create cannot deduplicate against it.
   */
  launchEnvFactory?: () => Promise<Record<string, string> | undefined>;
}

export interface TerminalResolvedShell {
  command: string;
  args: string[];
  cwd: string;
  displayCwd?: string;
}

export type TerminalCwdResolution =
  | { ok: true; cwd: string }
  | { ok: false; message: string };

export interface TerminalProcessHandle {
  /** Outer PTY process id. node-pty supplies this; test doubles may omit it. */
  readonly pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface TerminalPtyFactory {
  spawn(
    command: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
      useConpty?: boolean;
      useConptyDll?: boolean;
    },
  ): TerminalProcessHandle & {
    onData(callback: (data: string) => void): void;
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  };
}
