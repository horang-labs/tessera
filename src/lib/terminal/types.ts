export type TerminalShellKind = 'default' | 'cmd' | 'powershell' | 'wsl';

export interface TerminalCreateOptions {
  terminalId: string;
  userId: string;
  cwd?: string | null;
  sessionId?: string | null;
  shellKind?: TerminalShellKind;
  cols?: number;
  rows?: number;
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
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
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
