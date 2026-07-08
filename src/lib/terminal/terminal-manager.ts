import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import logger from '@/lib/logger';
import { buildSpawnEnv, getAgentEnvironment } from '@/lib/cli/spawn-cli';
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
// 슬래시 fallback 프리필 타이밍 휴리스틱 (PTY 실측 기반)
const PREFILL_IDLE_MS = 700; // 마지막 출력 후 이만큼 조용하면 ready로 간주
const PREFILL_MIN_OUTPUT_CHARS = 600; // claude 기동 화면이 충분히 그려졌다는 최소 기준
const PREFILL_HARD_TIMEOUT_MS = 8000; // 어떤 경우에도 이 시간 후엔 강제 프리필
const TERMINAL_TRACE_PATH = getTesseraDataPath('terminal-debug.log');
const nodeRequire = createRequire(__filename);

function hasUtf8Locale(value: string | undefined): boolean {
  return /\butf-?8\b/i.test(value ?? '');
}

function buildTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Merge the login-shell PATH (and on macOS, the full login-shell environment)
  // so that globally installed CLIs (npm, pnpm, volta, etc.) remain discoverable.
  // Finder/Dock-launched Electron apps inherit a minimal system PATH that omits
  // user-local bin directories; buildSpawnEnv resolves those from the login shell.
  const nextEnv = buildSpawnEnv(env);

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
  // 대기 중인 prefill 타이머를 즉시 취소하는 함수(close 시 write-after-kill 방지).
  cancelPrefill?: () => void;
}

async function loadNodePty(): Promise<TerminalPtyFactory> {
  try {
    const ptyFactory = await import('node-pty') as TerminalPtyFactory;
    ensureNodePtySpawnHelperExecutable();
    return ptyFactory;
  } catch (error) {
    throw new Error(
      `Terminal support requires node-pty to be installed and built: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (getRuntimePlatform() !== 'darwin') return;

  try {
    const packageJsonPath = nodeRequire.resolve('node-pty/package.json');
    const packageDir = path.dirname(packageJsonPath);
    const archDir = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    const helperPath = path.join(packageDir, 'prebuilds', archDir, 'spawn-helper');
    const stat = fs.statSync(helperPath);

    if (!stat.isFile() || (stat.mode & 0o111) === 0o111) {
      return;
    }

    fs.chmodSync(helperPath, stat.mode | 0o755);
  } catch (error) {
    logger.warn({
      error,
    }, 'Unable to ensure node-pty spawn-helper is executable');
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
        launchCommand: options.launchCommand,
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
      const terminalEnv = buildTerminalEnv(process.env);
      logger.debug({
        terminalId: options.terminalId,
        shellCommand: shell.command,
        shellArgs: shell.args,
        shellCwd: shell.cwd,
        envPath: terminalEnv.PATH,
        envPathLength: typeof terminalEnv.PATH === 'string' ? terminalEnv.PATH.length : 'undefined',
        envKeys: Object.keys(terminalEnv).length,
        envHasUndefinedValues: Object.entries(terminalEnv).filter(([, v]) => v === undefined).map(([k]) => k),
      }, 'Terminal env before PTY spawn');
      const terminalProcess = ptyFactory.spawn(shell.command, shell.args, {
        name: 'xterm-256color',
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: shell.cwd,
        env: terminalEnv,
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

      // 미지원 슬래시 명령 fallback: launchCommand(claude)가 기동된 뒤 입력창이
      // 준비되면 prefillInput을 개행 없이 write한다(자동 실행 X, 사용자가 Enter).
      // ready 판정은 출력이 잠시 idle해지는 시점을 휴리스틱으로 감지하고,
      // 8초 안전장치로 어떤 경우에도 한 번은 프리필되도록 한다.
      const prefillInput = options.prefillInput && options.prefillInput.length > 0
        ? options.prefillInput
        : undefined;
      let prefillSent = false;
      let prefillIdleTimer: ReturnType<typeof setTimeout> | null = null;
      let prefillHardTimer: ReturnType<typeof setTimeout> | null = null;
      let prefillSeenOutput = 0;
      const clearPrefillTimers = () => {
        if (prefillIdleTimer) { clearTimeout(prefillIdleTimer); prefillIdleTimer = null; }
        if (prefillHardTimer) { clearTimeout(prefillHardTimer); prefillHardTimer = null; }
      };
      // close()가 onExit보다 먼저 와도 대기 중인 prefill write가 킬된 PTY로 가지 않도록.
      runtime.cancelPrefill = clearPrefillTimers;
      const sendPrefill = () => {
        if (prefillSent || !prefillInput) return;
        prefillSent = true;
        clearPrefillTimers();
        // 개행은 자동 제출, 탭은 TUI 자동완성을 유발하므로 공백으로 치환한다
        // (자동 실행 방지 불변식). 사용자가 확인 후 직접 Enter를 눌러야 한다.
        const sanitized = prefillInput.replace(/[\r\n\t]+/g, ' ');
        try {
          terminalProcess.write(sanitized);
          logger.debug({ terminalId: options.terminalId }, 'Terminal prefill written');
        } catch (err) {
          // close()가 onExit보다 먼저 와 PTY가 이미 죽은 경우 write가 throw할 수 있다.
          // setTimeout 콜백에서 던지면 서버 프로세스가 죽으므로 조용히 무시한다.
          logger.debug({ terminalId: options.terminalId, err }, 'Terminal prefill write skipped (pty gone)');
        }
      };
      if (prefillInput) {
        prefillHardTimer = setTimeout(sendPrefill, PREFILL_HARD_TIMEOUT_MS);
      }

      terminalProcess.onData((data) => {
        this.appendBufferedOutput(runtime, data);
        this.sendToUser(options.userId, {
          type: 'terminal_output',
          terminalId: options.terminalId,
          data,
        });
        if (prefillInput && !prefillSent) {
          prefillSeenOutput += data.length;
          if (prefillIdleTimer) clearTimeout(prefillIdleTimer);
          prefillIdleTimer = setTimeout(() => {
            if (prefillSeenOutput >= PREFILL_MIN_OUTPUT_CHARS) {
              sendPrefill();
            } else {
              // 출력이 임계치 미만이어도 idle은 확인됨 → 짧게 한 번 더 기다린 뒤 강제
              // 실행한다(출력이 적은 환경에서 8초 hard timeout까지 대기하지 않도록).
              prefillIdleTimer = setTimeout(sendPrefill, PREFILL_IDLE_MS);
            }
          }, PREFILL_IDLE_MS);
        }
      });

      terminalProcess.onExit((event) => {
        clearPrefillTimers();
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
    runtime.cancelPrefill?.();
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
