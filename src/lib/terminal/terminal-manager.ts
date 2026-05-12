import fs from 'fs';
import logger from '@/lib/logger';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { resolveAllowedTerminalCwd, resolveTerminalShell } from './terminal-resolver';
import type {
  TerminalCreateOptions,
  TerminalProcessHandle,
  TerminalPtyFactory,
  TerminalShellKind,
} from './types';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

type SendToUser = (userId: string, message: ServerTransportMessage) => void;
const MAX_REPLAY_BUFFER_CHARS = 200_000;
const TERMINAL_TRACE_PATH = getTesseraDataPath('terminal-debug.log');

function hasUtf8Locale(value: string | undefined): boolean {
  return /\butf-?8\b/i.test(value ?? '');
}

function buildTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...env };

  if (
    getRuntimePlatform() === 'darwin'
    && !hasUtf8Locale(nextEnv.LC_ALL)
    && !hasUtf8Locale(nextEnv.LC_CTYPE)
    && !hasUtf8Locale(nextEnv.LANG)
  ) {
    nextEnv.LC_CTYPE = 'UTF-8';
  }

  return nextEnv;
}

interface TerminalRuntime {
  terminalId: string;
  userId: string;
  cwd: string;
  shell: string;
  process: TerminalProcessHandle;
  outputBuffer: string[];
  outputBufferSize: number;
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

function traceTerminalStage(stage: string, metadata: Record<string, unknown> = {}): void {
  if (process.env.TESSERA_TERMINAL_DEBUG !== '1') return;

  try {
    fs.appendFileSync(
      TERMINAL_TRACE_PATH,
      `${JSON.stringify({
        time: new Date().toISOString(),
        stage,
        ...metadata,
      })}\n`,
    );
  } catch {
    // Best-effort debug trace only.
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRuntime>();

  constructor(
    private readonly sendToUser: SendToUser,
    private readonly ptyFactoryLoader: () => Promise<TerminalPtyFactory> = loadNodePty,
  ) {}

  async create(options: TerminalCreateOptions): Promise<void> {
    const key = this.getKey(options.userId, options.terminalId);
    traceTerminalStage('create:enter', {
      terminalId: options.terminalId,
      userId: options.userId,
      cwd: options.cwd,
      sessionId: options.sessionId,
      shellKind: options.shellKind,
    });
    logger.debug({
      terminalId: options.terminalId,
      userId: options.userId,
      cwd: options.cwd,
      sessionId: options.sessionId,
      cols: options.cols,
      rows: options.rows,
    }, 'Terminal create requested');
    const existing = this.terminals.get(key);
    if (existing) {
      this.resize(options.terminalId, options.userId, options.cols ?? 80, options.rows ?? 24);
      this.sendStarted(existing);
      this.replayBufferedOutput(existing);
      return;
    }

    try {
      traceTerminalStage('load-node-pty:before', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal loading node-pty');
      const ptyFactory = await this.ptyFactoryLoader();
      traceTerminalStage('load-node-pty:after', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal loaded node-pty');
      traceTerminalStage('resolve-cwd:before', { terminalId: options.terminalId });
      const cwdResolution = resolveAllowedTerminalCwd({
        cwd: options.cwd,
        sessionId: options.sessionId,
      });
      traceTerminalStage('resolve-cwd:after', { terminalId: options.terminalId, cwdResolution });
      logger.debug({ terminalId: options.terminalId, cwdResolution }, 'Terminal cwd resolved');
      if (!cwdResolution.ok) {
        throw new Error(cwdResolution.message);
      }
      traceTerminalStage('resolve-shell-kind:before', { terminalId: options.terminalId });
      const shellKind = await this.resolveShellKind(options);
      traceTerminalStage('resolve-shell-kind:after', { terminalId: options.terminalId, shellKind });
      logger.debug({ terminalId: options.terminalId, shellKind }, 'Terminal shell kind resolved');
      traceTerminalStage('resolve-shell:before', { terminalId: options.terminalId });
      const shell = resolveTerminalShell({
        cwd: cwdResolution.cwd,
        shellKind,
      });
      traceTerminalStage('resolve-shell:after', {
        terminalId: options.terminalId,
        command: shell.command,
        args: shell.args,
        cwd: shell.cwd,
        displayCwd: shell.displayCwd,
      });
      logger.debug({
        terminalId: options.terminalId,
        command: shell.command,
        args: shell.args,
        cwd: shell.cwd,
        displayCwd: shell.displayCwd,
      }, 'Terminal shell resolved');
      traceTerminalStage('spawn:before', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal spawning PTY');
      const terminalProcess = ptyFactory.spawn(shell.command, shell.args, {
        name: 'xterm-256color',
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: shell.cwd,
        env: buildTerminalEnv(process.env),
        ...(getRuntimePlatform() === 'win32' ? { useConpty: false } : {}),
      });
      traceTerminalStage('spawn:after', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal PTY spawned');

      const runtime: TerminalRuntime = {
        terminalId: options.terminalId,
        userId: options.userId,
        cwd: shell.displayCwd ?? shell.cwd,
        shell: shell.command,
        process: terminalProcess,
        outputBuffer: [],
        outputBufferSize: 0,
      };
      this.terminals.set(key, runtime);

      terminalProcess.onData((data) => {
        this.appendBufferedOutput(runtime, data);
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

      this.sendStarted(runtime);
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
    this.terminals.delete(this.getKey(userId, terminalId));
    runtime.process.kill();
  }

  closeAllForUser(userId: string): void {
    const ownedTerminalIds = [...this.terminals.values()]
      .filter((runtime) => runtime.userId === userId)
      .map((runtime) => runtime.terminalId);
    for (const terminalId of ownedTerminalIds) {
      this.close(terminalId, userId);
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

  private async resolveShellKind(
    options: TerminalCreateOptions,
  ): Promise<TerminalShellKind | undefined> {
    if (options.shellKind && options.shellKind !== 'default') {
      return options.shellKind;
    }

    const agentEnvironment = await getAgentEnvironment(options.userId);
    return agentEnvironment === 'wsl' ? 'wsl' : options.shellKind;
  }

  private sendStarted(runtime: TerminalRuntime): void {
    this.sendToUser(runtime.userId, {
      type: 'terminal_started',
      terminalId: runtime.terminalId,
      cwd: runtime.cwd,
      shell: runtime.shell,
    });
  }

  private replayBufferedOutput(runtime: TerminalRuntime): void {
    if (runtime.outputBuffer.length === 0) return;
    this.sendToUser(runtime.userId, {
      type: 'terminal_output',
      terminalId: runtime.terminalId,
      data: runtime.outputBuffer.join(''),
    });
  }

  private appendBufferedOutput(runtime: TerminalRuntime, data: string): void {
    runtime.outputBuffer.push(data);
    runtime.outputBufferSize += data.length;

    while (runtime.outputBufferSize > MAX_REPLAY_BUFFER_CHARS && runtime.outputBuffer.length > 0) {
      const first = runtime.outputBuffer[0];
      const overflow = runtime.outputBufferSize - MAX_REPLAY_BUFFER_CHARS;
      if (first.length <= overflow) {
        runtime.outputBuffer.shift();
        runtime.outputBufferSize -= first.length;
      } else {
        runtime.outputBuffer[0] = first.slice(overflow);
        runtime.outputBufferSize -= overflow;
      }
    }
  }
}
