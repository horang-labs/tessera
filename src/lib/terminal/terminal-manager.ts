import logger from '@/lib/logger';
import { resolveAllowedTerminalCwd, resolveTerminalShell } from './terminal-resolver';
import type {
  TerminalCreateOptions,
  TerminalProcessHandle,
  TerminalPtyFactory,
} from './types';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

type SendToUser = (userId: string, message: ServerTransportMessage) => void;

interface TerminalRuntime {
  terminalId: string;
  userId: string;
  process: TerminalProcessHandle;
}

async function loadNodePty(): Promise<TerminalPtyFactory> {
  try {
    return await import('node-pty') as TerminalPtyFactory;
  } catch (error) {
    throw new Error(
      `Terminal support requires node-pty to be installed and built: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRuntime>();

  constructor(
    private readonly sendToUser: SendToUser,
    private readonly ptyFactoryLoader: () => Promise<TerminalPtyFactory> = loadNodePty,
  ) {}

  async create(options: TerminalCreateOptions): Promise<void> {
    this.close(options.terminalId, options.userId);

    try {
      const ptyFactory = await this.ptyFactoryLoader();
      const cwdResolution = resolveAllowedTerminalCwd({
        cwd: options.cwd,
        sessionId: options.sessionId,
      });
      if (!cwdResolution.ok) {
        throw new Error(cwdResolution.message);
      }
      const shell = resolveTerminalShell({
        cwd: cwdResolution.cwd,
        shellKind: options.shellKind,
      });
      const terminalProcess = ptyFactory.spawn(shell.command, shell.args, {
        name: 'xterm-256color',
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: shell.cwd,
        env: process.env,
      });

      const key = this.getKey(options.userId, options.terminalId);
      this.terminals.set(key, {
        terminalId: options.terminalId,
        userId: options.userId,
        process: terminalProcess,
      });

      terminalProcess.onData((data) => {
        this.sendToUser(options.userId, {
          type: 'terminal_output',
          terminalId: options.terminalId,
          data,
        });
      });

      terminalProcess.onExit((event) => {
        this.terminals.delete(key);
        this.sendToUser(options.userId, {
          type: 'terminal_exit',
          terminalId: options.terminalId,
          exitCode: event.exitCode,
          signal: event.signal,
        });
      });

      this.sendToUser(options.userId, {
        type: 'terminal_started',
        terminalId: options.terminalId,
        cwd: shell.cwd,
        shell: shell.command,
      });
    } catch (error) {
      logger.error({ error, terminalId: options.terminalId }, 'Failed to create terminal');
      this.sendToUser(options.userId, {
        type: 'terminal_error',
        terminalId: options.terminalId,
        message: error instanceof Error ? error.message : 'Failed to create terminal',
      });
    }
  }

  write(terminalId: string, userId: string, data: string): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    runtime?.process.write(data);
  }

  resize(terminalId: string, userId: string, cols: number, rows: number): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime) return;
    runtime.process.resize(
      Math.max(1, Math.floor(cols)),
      Math.max(1, Math.floor(rows)),
    );
  }

  close(terminalId: string, userId: string): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime) return;
    this.terminals.delete(terminalId);
    runtime.process.kill();
  }

  closeAllForUser(userId: string): void {
    for (const runtime of this.terminals.values()) {
      if (runtime.userId === userId) {
        this.close(runtime.terminalId, userId);
      }
    }
  }

  private getOwnedTerminal(terminalId: string, userId: string): TerminalRuntime | null {
    const runtime = this.terminals.get(this.getKey(userId, terminalId));
    if (!runtime) return null;
    if (runtime.userId !== userId) {
      logger.warn({ terminalId, userId }, 'Rejected terminal access for non-owner');
      this.sendToUser(userId, {
        type: 'terminal_error',
        terminalId,
        message: 'You do not own this terminal',
      });
      return null;
    }
    return runtime;
  }

  private getKey(userId: string, terminalId: string): string {
    return `${userId}:${terminalId}`;
  }
}
