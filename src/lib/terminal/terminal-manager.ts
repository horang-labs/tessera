import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import logger from '@/lib/logger';
import { buildSpawnEnv, getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import {
  formatTerminalShellPrefill,
  resolveAllowedTerminalCwd,
  resolveTerminalShell,
} from './terminal-resolver';
import {
  ownsTerminalHandoffLock,
  releaseTerminalHandoffByTerminal,
} from './terminal-handoff-lock';
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
const AUTOMATED_RESPONSE_FRAGMENT_GRACE_MS = 100;
const MAX_AUTOMATED_RESPONSE_CHARS = 4096;
const CLOSE_EXIT_GRACE_MS = 1500;
const CLOSE_EXIT_POLL_MS = 250;
const TERMINAL_TRACE_PATH = getTesseraDataPath('terminal-debug.log');
const nodeRequire = createRequire(__filename);

// xterm generates these replies while a TUI probes terminal capabilities.
// They arrive through onData just like keyboard input, but must not cancel a
// pending slash prefill. The token list mirrors replies emitted by xterm.js
// 5.x (focus, DA/DSR/DECRPM, window metrics, colors, and DECRQSS). Keep it
// narrow so keyboard escape sequences such as arrows still count as input.
const AUTOMATED_TERMINAL_RESPONSE_TOKEN = /^(?:\x1b\[[IO]|\x1b\[\??\d+;\d+R|\x1b\[[?>=]?[0-9;]*c|\x1b\[\??[0-9;]+n|\x1b\[\??\d+;[0-4]\$y|\x1b\[(?:4|6|8);\d+;\d+t|\x1b\](?:4;\d+|1[012]);rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+(?:\x07|\x1b\\)|\x1bP[01]\$r[^\x1b\x9c]*\x1b\\)/i;

type AutomatedResponseState = 'complete' | 'partial' | 'not-automated';

function isPotentialAutomatedResponsePrefix(value: string): boolean {
  if (value === '\x1b') return true;
  if (value.startsWith('\x1b[')) {
    const body = value.slice(2);
    if (body.length === 0) return true;
    // All xterm-generated CSI replies above consist of numeric parameters,
    // optional private markers/intermediates, then one final byte. A supported
    // final byte is consumed by AUTOMATED_TERMINAL_RESPONSE_TOKEN first.
    return /^[?>=]?[0-9;]*\$?$/.test(body);
  }
  if (value.startsWith('\x1b]')) {
    const body = value.slice(2);
    if (body.length === 0) return true;
    // OSC 4/10/11/12 color reports. Permit only a prefix of those identifiers
    // and their rgb payload while waiting for BEL or ST.
    return /^(?:4(?:;\d*)?|1[012]?)(?:;[rgb:0-9a-f/]*)?\x1b?$/i.test(body);
  }
  if (value.startsWith('\x1bP')) {
    const body = value.slice(2);
    if (body.length === 0) return true;
    // DECRQSS response: DCS 0|1 $ r <printable payload> ST.
    return /^(?:[01](?:\$r?[^\x1b\x9c]*)?)?\x1b?$/.test(body);
  }
  return false;
}

function classifyAutomatedTerminalResponse(value: string): AutomatedResponseState {
  if (value.length > MAX_AUTOMATED_RESPONSE_CHARS) return 'not-automated';
  let remaining = value;
  while (remaining.length > 0) {
    const token = remaining.match(AUTOMATED_TERMINAL_RESPONSE_TOKEN)?.[0];
    if (!token) {
      return isPotentialAutomatedResponsePrefix(remaining) ? 'partial' : 'not-automated';
    }
    remaining = remaining.slice(token.length);
  }
  return 'complete';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

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
  handoffSessionId?: string;
  prefillPending?: boolean;
  prefillResult?:
    | { status: 'written' }
    | { status: 'cancelled'; message: string };
  closing?: boolean;
  closeWatchdog?: ReturnType<typeof setTimeout>;
  closeWatchdogChecks?: number;
  automatedResponseCandidate?: string;
  automatedResponseTimer?: ReturnType<typeof setTimeout>;
  // 대기 중인 prefill 타이머를 즉시 취소하는 함수(close 시 write-after-kill 방지).
  cancelPrefill?: () => void;
}

interface PendingTerminalCreate {
  cancelled: boolean;
  terminalId: string;
  userId: string;
}

export interface TerminalLaunchReservation {
  readonly key: string;
  readonly terminalId: string;
  readonly userId: string;
  cancelled: boolean;
}

export interface TerminalManagerOptions {
  closeExitGraceMs?: number;
  closeExitPollMs?: number;
  processIsAlive?: (pid: number) => boolean;
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
  private readonly pendingCreates = new Map<string, PendingTerminalCreate>();
  private readonly launchReservations = new Map<string, TerminalLaunchReservation>();

  constructor(
    private readonly sendToUser: SendToUser,
    private readonly ptyFactoryLoader: () => Promise<TerminalPtyFactory> = loadNodePty,
    private readonly managerOptions: TerminalManagerOptions = {},
  ) {}

  reserveTerminalLaunch(terminalId: string, userId: string): TerminalLaunchReservation | null {
    const key = this.getKey(userId, terminalId);
    if (
      this.terminals.has(key)
      || this.pendingCreates.has(key)
      || this.launchReservations.has(key)
    ) {
      return null;
    }
    const reservation: TerminalLaunchReservation = {
      key,
      terminalId,
      userId,
      cancelled: false,
    };
    this.launchReservations.set(key, reservation);
    return reservation;
  }

  isTerminalLaunchReserved(reservation: TerminalLaunchReservation): boolean {
    return !reservation.cancelled
      && this.launchReservations.get(reservation.key) === reservation;
  }

  releaseTerminalLaunchReservation(reservation: TerminalLaunchReservation): void {
    if (this.launchReservations.get(reservation.key) === reservation) {
      this.launchReservations.delete(reservation.key);
    }
    reservation.cancelled = true;
  }

  attach(
    terminalId: string,
    userId: string,
    cols = 80,
    rows = 24,
  ): boolean {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (runtime) {
      this.resize(terminalId, userId, cols, rows);
      this.sendStarted(runtime);
      this.replayBufferedOutput(runtime);
      this.replayPrefillResult(runtime);
      return true;
    }
    const key = this.getKey(userId, terminalId);
    return this.pendingCreates.has(key) || this.launchReservations.has(key);
  }

  async create(
    options: TerminalCreateOptions,
    launchReservation?: TerminalLaunchReservation,
  ): Promise<void> {
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
      if (options.launchSpec) {
        throw new Error('This terminal is already running.');
      }
      this.resize(options.terminalId, options.userId, options.cols ?? 80, options.rows ?? 24);
      this.sendStarted(existing);
      this.replayBufferedOutput(existing);
      return;
    }
    if (this.pendingCreates.has(key)) {
      if (options.launchSpec) {
        throw new Error('This terminal is already starting.');
      }
      return;
    }
    if (launchReservation) {
      if (launchReservation.key !== key || !this.isTerminalLaunchReserved(launchReservation)) {
        throw new Error('Terminal startup was cancelled.');
      }
      this.launchReservations.delete(key);
    } else if (this.launchReservations.has(key)) {
      throw new Error('This terminal is reserved for a command launch.');
    }
    const pendingCreate: PendingTerminalCreate = {
      cancelled: false,
      terminalId: options.terminalId,
      userId: options.userId,
    };
    this.pendingCreates.set(key, pendingCreate);
    const handoffSessionId = options.launchSpec?.handoffSessionId;
    const assertCreateActive = () => {
      if (pendingCreate.cancelled || this.pendingCreates.get(key) !== pendingCreate) {
        throw new Error('Terminal startup was cancelled.');
      }
    };

    try {
      assertCreateActive();
      if (handoffSessionId && !ownsTerminalHandoffLock(
        handoffSessionId,
        options.userId,
        options.terminalId,
      )) {
        throw new Error('The Codex terminal handoff was cancelled.');
      }
      traceTerminalStage('load-node-pty:before', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal loading node-pty');
      const ptyFactory = await this.ptyFactoryLoader();
      assertCreateActive();
      traceTerminalStage('load-node-pty:after', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal loaded node-pty');
      traceTerminalStage('resolve-cwd:before', { terminalId: options.terminalId });
      const cwdResolution = resolveAllowedTerminalCwd({
        cwd: options.launchSpec?.cwd ?? options.cwd,
        sessionId: options.sessionId,
        allowFallback: !options.launchSpec,
      });
      traceTerminalStage('resolve-cwd:after', { terminalId: options.terminalId, cwdResolution });
      logger.debug({ terminalId: options.terminalId, cwdResolution }, 'Terminal cwd resolved');
      if (!cwdResolution.ok) {
        throw new Error(cwdResolution.message);
      }
      traceTerminalStage('resolve-shell-kind:before', { terminalId: options.terminalId });
      const shellKind = await this.resolveShellKind(options);
      assertCreateActive();
      traceTerminalStage('resolve-shell-kind:after', { terminalId: options.terminalId, shellKind });
      logger.debug({ terminalId: options.terminalId, shellKind }, 'Terminal shell kind resolved');
      traceTerminalStage('resolve-shell:before', { terminalId: options.terminalId });
      const shell = resolveTerminalShell({
        cwd: cwdResolution.cwd,
        shellKind,
        launchSpec: options.launchSpec,
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
      if (handoffSessionId && !ownsTerminalHandoffLock(
        handoffSessionId,
        options.userId,
        options.terminalId,
      )) {
        throw new Error('The Codex terminal handoff was cancelled.');
      }
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
        handoffSessionId: options.launchSpec?.handoffSessionId,
      };
      this.terminals.set(key, runtime);

      // 미지원 슬래시 명령 fallback: launchCommand(claude)가 기동된 뒤 입력창이
      // 준비되면 prefillInput을 개행 없이 write한다(자동 실행 X, 사용자가 Enter).
      // ready 판정은 출력이 잠시 idle해지는 시점을 휴리스틱으로 감지하고,
      // 8초 안전장치로 어떤 경우에도 한 번은 프리필되도록 한다.
      const resolvedPrefill = options.launchSpec?.shellPrefillArgv
        ? formatTerminalShellPrefill({
            ...options.launchSpec.shellPrefillArgv,
            shellKind,
          })
        : options.launchSpec?.prefillInput;
      const prefillInput = resolvedPrefill && resolvedPrefill.length > 0
        ? resolvedPrefill
        : undefined;
      runtime.prefillPending = Boolean(prefillInput);
      let prefillSent = false;
      let prefillIdleTimer: ReturnType<typeof setTimeout> | null = null;
      let prefillHardTimer: ReturnType<typeof setTimeout> | null = null;
      let prefillSeenOutput = 0;
      const clearPrefillTimers = () => {
        if (prefillIdleTimer) { clearTimeout(prefillIdleTimer); prefillIdleTimer = null; }
        if (prefillHardTimer) { clearTimeout(prefillHardTimer); prefillHardTimer = null; }
      };
      // close()가 onExit보다 먼저 와도 대기 중인 prefill write가 킬된 PTY로 가지 않도록.
      runtime.cancelPrefill = () => {
        prefillSent = true;
        runtime.prefillPending = false;
        this.clearAutomatedResponseCandidate(runtime);
        clearPrefillTimers();
      };
      const sendPrefill = () => {
        if (prefillSent || !prefillInput) return;
        if (runtime.automatedResponseCandidate) {
          // Do not write into the middle of a split xterm protocol reply. The
          // fragment grace timer will either complete it or cancel the prefill.
          prefillHardTimer = setTimeout(sendPrefill, AUTOMATED_RESPONSE_FRAGMENT_GRACE_MS);
          return;
        }
        prefillSent = true;
        clearPrefillTimers();
        // 모든 C0/C1 control bytes를 제거한다. 특히 CR/LF는 자동 제출이고
        // tab/escape는 TUI 동작을 유발하므로 사용자가 직접 Enter를 누르게 한다.
        const sanitized = prefillInput.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');
        try {
          terminalProcess.write(sanitized);
          runtime.prefillPending = false;
          runtime.cancelPrefill = undefined;
          runtime.prefillResult = { status: 'written' };
          this.sendToUser(options.userId, {
            type: 'terminal_prefill_written',
            terminalId: options.terminalId,
          });
          logger.debug({ terminalId: options.terminalId }, 'Terminal prefill written');
        } catch (err) {
          runtime.prefillPending = false;
          runtime.cancelPrefill = undefined;
          const message = 'The terminal opened, but the command could not be entered. Your draft was kept.';
          runtime.prefillResult = { status: 'cancelled', message };
          this.sendToUser(options.userId, {
            type: 'terminal_prefill_cancelled',
            terminalId: options.terminalId,
            message,
          });
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
        this.finalizeTerminalExit(runtime, key, event);
      });

      this.sendStarted(runtime);
    } catch (error) {
      if (handoffSessionId && ownsTerminalHandoffLock(
        handoffSessionId,
        options.userId,
        options.terminalId,
      )) {
        releaseTerminalHandoffByTerminal(options.userId, options.terminalId);
      }
      logger.error({ error, terminalId: options.terminalId }, 'Failed to create terminal');
      this.sendToUser(options.userId, {
        type: 'terminal_error',
        terminalId: options.terminalId,
        message: error instanceof Error ? error.message : 'Failed to create terminal',
      });
    } finally {
      if (this.pendingCreates.get(key) === pendingCreate) {
        this.pendingCreates.delete(key);
      }
    }
  }

  write(terminalId: string, userId: string, data: string): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (runtime?.prefillPending && data.length > 0) {
      const candidate = `${runtime.automatedResponseCandidate ?? ''}${data}`;
      const responseState = classifyAutomatedTerminalResponse(candidate);
      if (responseState === 'complete') {
        this.clearAutomatedResponseCandidate(runtime);
      } else if (responseState === 'partial') {
        this.clearAutomatedResponseCandidate(runtime);
        runtime.automatedResponseCandidate = candidate;
        runtime.automatedResponseTimer = setTimeout(() => {
          if (runtime.prefillPending && runtime.automatedResponseCandidate === candidate) {
            this.cancelPendingPrefill(
              runtime,
              'Terminal input arrived before the command was ready. Your draft was kept.',
            );
          }
        }, AUTOMATED_RESPONSE_FRAGMENT_GRACE_MS);
        runtime.automatedResponseTimer.unref?.();
      } else {
        this.clearAutomatedResponseCandidate(runtime);
        // User input wins over a delayed automatic prefill; concatenating the
        // slash onto user text would be surprising and potentially unsafe.
        this.cancelPendingPrefill(
          runtime,
          'Terminal input arrived before the command was ready. Your draft was kept.',
        );
      }
    }
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
    const key = this.getKey(userId, terminalId);
    const reservation = this.launchReservations.get(key);
    if (reservation) {
      reservation.cancelled = true;
      this.launchReservations.delete(key);
    }
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime) {
      const pendingCreate = this.pendingCreates.get(key);
      if (pendingCreate) pendingCreate.cancelled = true;
      // A handoff can already be leased while launch intent resolution or PTY
      // loading is still awaiting. Closing the panel must release it now.
      releaseTerminalHandoffByTerminal(userId, terminalId);
      return;
    }
    if (runtime.closing) return;
    runtime.closing = true;
    this.cancelPendingPrefill(
      runtime,
      'The terminal was closed before the command could be entered. Your draft was kept.',
    );
    try {
      // Keep the handoff lease until node-pty confirms process exit. Releasing
      // before onExit can briefly give the TUI and app-server the same thread.
      runtime.process.kill();
    } catch (error) {
      // A thrown kill does not prove the PTY is dead. Keep ownership until the
      // exit callback or PID liveness check confirms termination.
      logger.warn({ error, terminalId }, 'Terminal close signal failed; awaiting exit confirmation');
    }
    if (this.terminals.get(key) === runtime) {
      this.scheduleCloseWatchdog(
        runtime,
        key,
        this.managerOptions.closeExitGraceMs ?? CLOSE_EXIT_GRACE_MS,
      );
    }
  }

  closeAllForUser(userId: string): void {
    const keyPrefix = `${userId}:`;
    for (const [key, reservation] of this.launchReservations) {
      if (!key.startsWith(keyPrefix)) continue;
      reservation.cancelled = true;
      this.launchReservations.delete(key);
      releaseTerminalHandoffByTerminal(reservation.userId, reservation.terminalId);
    }
    for (const [key, pendingCreate] of this.pendingCreates) {
      if (!key.startsWith(keyPrefix)) continue;
      pendingCreate.cancelled = true;
      releaseTerminalHandoffByTerminal(pendingCreate.userId, pendingCreate.terminalId);
    }
    const ownedTerminalIds = [...this.terminals.values()]
      .filter((runtime) => runtime.userId === userId)
      .map((runtime) => runtime.terminalId);
    for (const terminalId of ownedTerminalIds) {
      this.close(terminalId, userId);
    }
  }

  hasOrPendingTerminal(terminalId: string, userId: string): boolean {
    const key = this.getKey(userId, terminalId);
    return this.terminals.has(key)
      || this.pendingCreates.has(key)
      || this.launchReservations.has(key);
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

  private cancelPendingPrefill(runtime: TerminalRuntime, message: string): void {
    if (!runtime.prefillPending) return;
    this.clearAutomatedResponseCandidate(runtime);
    runtime.cancelPrefill?.();
    runtime.cancelPrefill = undefined;
    runtime.prefillResult = { status: 'cancelled', message };
    this.sendToUser(runtime.userId, {
      type: 'terminal_prefill_cancelled',
      terminalId: runtime.terminalId,
      message,
    });
  }

  private clearAutomatedResponseCandidate(runtime: TerminalRuntime): void {
    if (runtime.automatedResponseTimer) {
      clearTimeout(runtime.automatedResponseTimer);
      runtime.automatedResponseTimer = undefined;
    }
    runtime.automatedResponseCandidate = undefined;
  }

  private scheduleCloseWatchdog(runtime: TerminalRuntime, key: string, delayMs: number): void {
    if (runtime.closeWatchdog) clearTimeout(runtime.closeWatchdog);
    runtime.closeWatchdog = setTimeout(() => {
      runtime.closeWatchdog = undefined;
      if (this.terminals.get(key) !== runtime || !runtime.closing) return;

      const pid = runtime.process.pid;
      if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
        // Production node-pty handles always expose a PID. Without one there is
        // no safe way to infer death from a missing onExit callback.
        logger.error({ terminalId: runtime.terminalId }, 'Cannot confirm closing terminal exit without a PID');
        return;
      }

      const alive = (this.managerOptions.processIsAlive ?? isProcessAlive)(pid as number);
      if (!alive) {
        this.finalizeTerminalExit(runtime, key, { exitCode: 0 });
        return;
      }

      runtime.closeWatchdogChecks = (runtime.closeWatchdogChecks ?? 0) + 1;
      // If the graceful close did not take effect, escalate once and then keep
      // polling. Even if this throws, retain the lease while the PID is alive.
      if (runtime.closeWatchdogChecks === 1) {
        try {
          runtime.process.kill(getRuntimePlatform() === 'win32' ? undefined : 'SIGKILL');
        } catch (error) {
          logger.warn({ error, terminalId: runtime.terminalId }, 'Terminal force-close signal failed');
        }
      }
      this.scheduleCloseWatchdog(
        runtime,
        key,
        this.managerOptions.closeExitPollMs ?? CLOSE_EXIT_POLL_MS,
      );
    }, Math.max(0, delayMs));
    runtime.closeWatchdog.unref?.();
  }

  private finalizeTerminalExit(
    runtime: TerminalRuntime,
    key: string,
    event: { exitCode: number; signal?: number },
  ): void {
    if (this.terminals.get(key) !== runtime) return;
    if (runtime.closeWatchdog) {
      clearTimeout(runtime.closeWatchdog);
      runtime.closeWatchdog = undefined;
    }
    this.clearAutomatedResponseCandidate(runtime);
    this.cancelPendingPrefill(
      runtime,
      'The terminal exited before the command could be entered. Your draft was kept.',
    );
    this.terminals.delete(key);
    if (runtime.handoffSessionId && ownsTerminalHandoffLock(
      runtime.handoffSessionId,
      runtime.userId,
      runtime.terminalId,
    )) {
      releaseTerminalHandoffByTerminal(runtime.userId, runtime.terminalId);
    }
    this.sendToUser(runtime.userId, {
      type: 'terminal_exit',
      terminalId: runtime.terminalId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
  }

  private replayPrefillResult(runtime: TerminalRuntime): void {
    if (runtime.prefillResult?.status === 'written') {
      this.sendToUser(runtime.userId, {
        type: 'terminal_prefill_written',
        terminalId: runtime.terminalId,
      });
      return;
    }
    if (runtime.prefillResult?.status === 'cancelled') {
      this.sendToUser(runtime.userId, {
        type: 'terminal_prefill_cancelled',
        terminalId: runtime.terminalId,
        message: runtime.prefillResult.message,
      });
    }
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
