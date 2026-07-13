export type TerminalShellKind = 'default' | 'cmd' | 'powershell' | 'wsl';

/** Client-safe request. Executable, argv, and Codex thread ids are server-owned. */
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
  cwd?: string | null;
  sessionId?: string | null;
  shellKind?: TerminalShellKind;
  cols?: number;
  rows?: number;
  launchSpec?: TerminalLaunchSpec;
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
  /** Outer PTY process id. node-pty always supplies this; test doubles may omit it. */
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
