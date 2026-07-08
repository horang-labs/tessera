export type TerminalShellKind = 'default' | 'cmd' | 'powershell' | 'wsl';

export interface TerminalCreateOptions {
  terminalId: string;
  userId: string;
  cwd?: string | null;
  sessionId?: string | null;
  shellKind?: TerminalShellKind;
  cols?: number;
  rows?: number;
  /**
   * 셸이 뜨자마자 실행할 명령 (예: "claude"). 미지원 슬래시 명령을
   * 터미널 fallback으로 처리할 때 사용. 종료 후에는 인터랙티브 셸로 돌아간다.
   */
  launchCommand?: string;
  /**
   * launchCommand 기동 후 입력창에 프리필할 텍스트(예: "/config").
   * 출력이 idle 상태가 되면 개행 없이 write되어 자동 실행되지 않는다.
   */
  prefillInput?: string;
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
