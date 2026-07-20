import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
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
import { getServerPort } from '@/lib/server-port';
import { revokePaneTokensForTerminal } from './pane-token-registry';
import { cleanupCodexOverlayForTerminal } from './codex-overlay';
import { TerminalHeadlessModel } from './terminal-headless-model';
import { normalizeTerminalColorEnv } from './terminal-color-env';
import { createTerminalAppearanceController } from './terminal-appearance-controller';
import {
  ownsTerminalHandoffLock,
  releaseTerminalHandoffByTerminal,
} from './terminal-handoff-lock';
import type {
  TerminalCreateOptions,
  TerminalAppearance,
  TerminalProcessHandle,
  TerminalPtyFactory,
  TerminalShellKind,
} from './types';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { shouldReleasePreviewRuntime } from './terminal-preview-policy';
import { TerminalResizeOutputTransaction } from './terminal-resize-output-transaction';

type SendToConnection = (connectionId: string, message: ServerTransportMessage) => void;
type TerminalSessionStateMessage = Extract<ServerTransportMessage, { type: 'session_state' }>;
export interface TerminalSessionRuntimeInfo {
  cwd: string;
  generation: number;
  sessionId: string;
  terminalId: string;
  userId: string;
}
export type ObserveTerminalSessionRuntime = (
  info: TerminalSessionRuntimeInfo,
) => void | (() => void) | Promise<void | (() => void)>;
const MAX_REPLAY_BUFFER_CHARS = 200_000;
const MAX_TERMINAL_COLS = 1_000;
const MAX_TERMINAL_ROWS = 500;
// 슬래시 fallback 프리필 타이밍 휴리스틱 (PTY 실측 기반)
const PREFILL_IDLE_MS = 700; // 마지막 출력 후 이만큼 조용하면 ready로 간주
const PREFILL_MIN_OUTPUT_CHARS = 600; // claude 기동 화면이 충분히 그려졌다는 최소 기준
const PREFILL_HARD_TIMEOUT_MS = 8000; // 어떤 경우에도 이 시간 후엔 강제 프리필
const AUTOMATED_RESPONSE_FRAGMENT_GRACE_MS = 100;
const MAX_AUTOMATED_RESPONSE_CHARS = 4096;
const AGENT_INTERRUPT_SETTLE_MS = 500;
const INTERRUPTED_LATE_RUNNING_SUPPRESSION_MS = 15_000;
const CLOSE_EXIT_GRACE_MS = 1500;
const CLOSE_EXIT_POLL_MS = 250;
const TERMINAL_TRACE_PATH = getTesseraDataPath('terminal-debug.log');
const nodeRequire = createRequire(__filename);

const AUTOMATED_TERMINAL_RESPONSE_TOKEN = /^(?:\x1b\[[IO]|\x1b\[\??\d+;\d+R|\x1b\[[?>=]?[0-9;]*c|\x1b\[\??[0-9;]+n|\x1b\[\??\d+;[0-4]\$y|\x1b\[(?:4|6|8);\d+;\d+t|\x1b\](?:4;\d+|1[012]);rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+(?:\x07|\x1b\\)|\x1bP[01]\$r[^\x1b\x9c]*\x1b\\)/i;

type AutomatedResponseState = 'complete' | 'partial' | 'not-automated';

function isPotentialAutomatedResponsePrefix(value: string): boolean {
  if (value === '\x1b') return true;
  if (value.startsWith('\x1b[')) {
    const body = value.slice(2);
    return body.length === 0 || /^[?>=]?[0-9;]*\$?$/.test(body);
  }
  if (value.startsWith('\x1b]')) {
    const body = value.slice(2);
    return body.length === 0 || /^(?:4(?:;\d*)?|1[012]?)(?:;[rgb:0-9a-f/]*)?\x1b?$/i.test(body);
  }
  if (value.startsWith('\x1bP')) {
    const body = value.slice(2);
    return body.length === 0 || /^(?:[01](?:\$r?[^\x1b\x9c]*)?)?\x1b?$/.test(body);
  }
  return false;
}

function classifyAutomatedTerminalResponse(value: string): AutomatedResponseState {
  if (value.length > MAX_AUTOMATED_RESPONSE_CHARS) return 'not-automated';
  let remaining = value;
  while (remaining.length > 0) {
    const token = remaining.match(AUTOMATED_TERMINAL_RESPONSE_TOKEN)?.[0];
    if (!token) return isPotentialAutomatedResponsePrefix(remaining) ? 'partial' : 'not-automated';
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

function buildTerminalEnv(
  env: NodeJS.ProcessEnv,
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
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

  // Provider-specific launch metadata inherited by the PTY child process.
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) nextEnv[k] = v;
    }
  }

  return normalizeTerminalColorEnv(nextEnv);
}

interface TerminalOutputFrame {
  seq: number;
  data: string;
}

interface TerminalSubscriber {
  connectionId: string;
  surfaceId: string;
  ready: boolean;
  pendingFrames: TerminalOutputFrame[];
  pendingExit?: { exitCode: number; signal?: number };
}

interface TerminalRuntime {
  terminalId: string;
  userId: string;
  sessionId: string | null;
  interruptInputPolicy: NonNullable<TerminalCreateOptions['interruptInputPolicy']>;
  generation: number;
  sequence: number;
  ended: boolean;
  exitEvent?: { exitCode: number; signal?: number };
  cwd: string;
  shell: string;
  appearanceChangePolicy: NonNullable<TerminalCreateOptions['appearanceChangePolicy']>;
  resizeScrollbackPolicy: NonNullable<TerminalCreateOptions['resizeScrollbackPolicy']>;
  canRestartForAppearance?: () => boolean;
  appearanceRestartIntent?: TerminalCreateOptions['appearanceRestartIntent'];
  appearanceRestartPending: boolean;
  process: TerminalProcessHandle;
  appearanceController?: ReturnType<typeof createTerminalAppearanceController>;
  model: TerminalHeadlessModelLike;
  cols: number;
  rows: number;
  subscribers: Map<string, TerminalSubscriber>;
  viewportOwner: string | null;
  outputBuffer: string[];
  outputBufferSize: number;
  // 출력 coalescing(M0): 한 event-loop tick에 도착한 청크를 모아 setImmediate에서
  // 1회 WS 전송한다. replay 버퍼/prefill 감지와는 독립.
  pendingSend: string[];
  pendingSendTimer: ReturnType<typeof setImmediate> | null;
  resizeOutputTransaction?: TerminalResizeOutputTransaction;
  handoffSessionId?: string;
  prefillPending?: boolean;
  closing?: boolean;
  closeWatchdog?: ReturnType<typeof setTimeout>;
  closeWatchdogChecks?: number;
  automatedResponseCandidate?: string;
  automatedResponseTimer?: ReturnType<typeof setTimeout>;
  interruptInferenceTimer?: ReturnType<typeof setTimeout>;
  interruptInferredAt?: number;
  // 대기 중인 prefill 타이머를 즉시 취소하는 함수(close 시 write-after-kill 방지).
  cancelPrefill?: () => void;
  disposeSessionObservers: Array<() => void>;
  lastSessionState?: TerminalSessionStateMessage;
  providerSessionId?: string;
  retiredProviderSessionIds: Set<string>;
  backgroundProviderSessionIds: Set<string>;
  reboundFromSessionIds: Set<string>;
  previewOwnerToken?: string;
}

/** The runtime only needs these members; tests can inject a stub model. */
export type TerminalHeadlessModelLike = Pick<
  TerminalHeadlessModel,
  'write' | 'resize' | 'snapshot' | 'dispose'
>;

export interface TerminalManagerOptions {
  closeExitGraceMs?: number;
  closeExitPollMs?: number;
  processIsAlive?: (pid: number) => boolean;
  /**
   * Upper bound on waiting for the headless-model snapshot during attach.
   * A wedged model write chain must degrade to the raw fallback snapshot
   * instead of freezing the reattaching surface forever.
   */
  snapshotTimeoutMs?: number;
  createHeadlessModel?: (cols: number, rows: number) => TerminalHeadlessModelLike;
  onSessionRuntimeStateChange?: (state: {
    sessionId: string;
    terminalId: string;
    userId: string;
    running: boolean;
  }) => void;
  /** Broadcast a PTY-only state inferred from terminal lifecycle input. */
  onSessionStateChange?: (state: {
    message: TerminalSessionStateMessage;
    userId: string;
  }) => void;
  interruptSettleMs?: number;
  onSessionRuntimeRebound?: (state: {
    previousSessionId: string;
    sessionId: string;
    terminalId: string;
    userId: string;
  }) => void;
}

function normalizeTerminalDimension(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value!)));
}

/**
 * Attach must never hang on the model snapshot. A single lost xterm write
 * callback wedges the model's write chain forever, and every later reattach
 * would otherwise stall before `subscriber.ready` — the surface then shows a
 * stale screen with all live output trapped in pendingFrames.
 */
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 3_000;

async function resolveSnapshotWithTimeout(
  model: TerminalHeadlessModelLike,
  timeoutMs: number,
): Promise<{ data: string; cols: number; rows: number }> {
  const snapshot = model.snapshot();
  // If the timeout wins, a late rejection from the losing promise must not
  // surface as an unhandled rejection.
  snapshot.catch(() => {});
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      snapshot,
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new Error(`Terminal snapshot timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timerId);
  }
}

function appendWslenv(
  env: NodeJS.ProcessEnv,
  entries: Array<{ name: string; path?: boolean }>,
): void {
  const existing = (env.WSLENV ?? '').split(':').filter(Boolean);
  const byName = new Map(existing.map((entry) => [entry.split('/')[0], entry]));
  for (const entry of entries) {
    if (env[entry.name] === undefined) continue;
    byName.set(entry.name, `${entry.name}${entry.path ? '/p' : ''}`);
  }
  if (byName.size > 0) env.WSLENV = [...byName.values()].join(':');
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
  private readonly openingTerminals = new Map<string, Promise<TerminalRuntime>>();
  private readonly openingByTerminalKey = new Map<string, Promise<TerminalRuntime>>();
  private readonly openingSessionByTerminalKey = new Map<string, string | null>();
  private readonly openingPreviewOwnerByTerminalKey = new Map<string, string>();
  private readonly sessionBindings = new Map<string, string>();
  private readonly terminalReservations = new Map<string, string>();
  private readonly reservedSessionByTerminalKey = new Map<string, string>();
  private readonly generationByTerminal = new Map<string, number>();
  private readonly disconnectedConnections = new Set<string>();
  private readonly blockedSessions = new Set<string>();
  private readonly cancelledOpeningKeys = new Set<string>();
  private shuttingDown = false;

  constructor(
    private readonly sendToConnection: SendToConnection,
    private readonly ptyFactoryLoader: () => Promise<TerminalPtyFactory> = loadNodePty,
    private readonly observeSessionRuntime?: ObserveTerminalSessionRuntime,
    private readonly managerOptions: TerminalManagerOptions = {},
  ) {}

  async create(options: TerminalCreateOptions): Promise<void> {
    const blockedSessionKey = options.sessionId
      ? this.getSessionKey(options.userId, options.sessionId)
      : null;
    if (this.shuttingDown || (blockedSessionKey && this.blockedSessions.has(blockedSessionKey))) {
      if (options.sessionId) this.clearTerminalReservation(options.userId, options.sessionId);
      if (options.launchSpec?.handoffSessionId) {
        releaseTerminalHandoffByTerminal(options.userId, options.terminalId);
      }
      options.launchObserverDisposer?.();
      revokePaneTokensForTerminal(options.terminalId);
      cleanupCodexOverlayForTerminal(options.terminalId);
      this.sendToConnection(options.connectionId, {
        type: 'terminal_error',
        terminalId: options.terminalId,
        surfaceId: options.surfaceId,
        message: this.shuttingDown
          ? 'Terminal host is shutting down.'
          : 'Session is closing and cannot open a terminal.',
      });
      return;
    }

    const resolvedTerminalId = options.sessionId
      ? this.reserveTerminalId(options.userId, options.terminalId, options.sessionId)
      : options.terminalId;
    const resolvedOptions: TerminalCreateOptions = {
      ...options,
      terminalId: resolvedTerminalId,
    };
    const key = this.getKey(resolvedOptions.userId, resolvedOptions.terminalId);
    const openingKey = this.getOpeningKey(
      resolvedOptions.userId,
      resolvedOptions.terminalId,
      resolvedOptions.sessionId,
    );
    traceTerminalStage('create:enter', {
      terminalId: resolvedOptions.terminalId,
      requestedTerminalId: options.terminalId,
      userId: resolvedOptions.userId,
      cwd: resolvedOptions.cwd,
      sessionId: resolvedOptions.sessionId,
      shellKind: resolvedOptions.shellKind,
    });
    logger.debug({
      terminalId: resolvedOptions.terminalId,
      userId: resolvedOptions.userId,
      cwd: resolvedOptions.cwd,
      sessionId: resolvedOptions.sessionId,
      cols: resolvedOptions.cols,
      rows: resolvedOptions.rows,
    }, 'Terminal create requested');

    let runtime = this.terminals.get(key);
    let createdByRequest = false;
    if (!runtime) {
      // A session is the creation lock, not the client-proposed terminal id.
      // Two windows can propose different ids before the first spawn establishes
      // its binding; both must still await one PTY.
      let opening = this.openingTerminals.get(openingKey);
      if (!opening) {
        createdByRequest = true;
        this.cancelledOpeningKeys.delete(key);
        opening = this.spawnRuntime(resolvedOptions, key);
        this.openingTerminals.set(openingKey, opening);
        this.openingByTerminalKey.set(key, opening);
        this.openingSessionByTerminalKey.set(key, resolvedOptions.sessionId ?? null);
        if (resolvedOptions.previewOwnerToken) {
          this.openingPreviewOwnerByTerminalKey.set(key, resolvedOptions.previewOwnerToken);
        }
        void opening.finally(() => {
          if (this.openingTerminals.get(openingKey) === opening) {
            this.openingTerminals.delete(openingKey);
          }
          if (this.openingByTerminalKey.get(key) === opening) {
            this.openingByTerminalKey.delete(key);
            this.openingSessionByTerminalKey.delete(key);
            this.openingPreviewOwnerByTerminalKey.delete(key);
          }
          this.cancelledOpeningKeys.delete(key);
        }).catch(() => {});
      }

      try {
        runtime = await opening;
      } catch (error) {
        if (!createdByRequest) {
          options.launchObserverDisposer?.();
        }
        logger.error({ error, terminalId: resolvedOptions.terminalId }, 'Failed to create terminal');
        this.sendToConnection(resolvedOptions.connectionId, {
          type: 'terminal_error',
          terminalId: resolvedOptions.terminalId,
          surfaceId: resolvedOptions.surfaceId,
          message: error instanceof Error ? error.message : 'Failed to create terminal',
        });
        return;
      }
    }

    if (this.shuttingDown && !runtime.ended) {
      this.closeRuntime(runtime);
    }
    if (!createdByRequest) {
      options.launchObserverDisposer?.();
    }
    if (this.disconnectedConnections.has(resolvedOptions.connectionId)) return;
    // A natural exit can race the first/cold attach. Attach once to deliver the
    // bounded fallback snapshot and exit diagnostics. Explicit close/shutdown
    // has no exitEvent and must stay silent.
    if (runtime.ended && !runtime.exitEvent) return;
    await this.attachRuntime(runtime, resolvedOptions, !createdByRequest);
  }

  private async spawnRuntime(
    options: TerminalCreateOptions,
    key: string,
  ): Promise<TerminalRuntime> {
    let terminalProcess: (TerminalProcessHandle & {
      onData(callback: (data: string) => void): void;
      onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
    }) | null = null;
    let model: TerminalHeadlessModelLike | null = null;
    const assertOpeningActive = () => {
      if (this.cancelledOpeningKeys.has(key)) {
        throw new Error('Terminal startup was cancelled.');
      }
    };

    try {
      assertOpeningActive();
      traceTerminalStage('load-node-pty:before', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal loading node-pty');
      const ptyFactory = await this.ptyFactoryLoader();
      assertOpeningActive();
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
      assertOpeningActive();
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
      const extraEnv: Record<string, string | undefined> = {
        ...(options.paneToken
          ? {
              TESSERA_PANE_TOKEN: options.paneToken,
              TESSERA_SESSION_ID: options.sessionId ?? '',
              TESSERA_HOOK_PORT: String(getServerPort()),
            }
          : {}),
        ...(options.launchEnv ?? {}),
      };
      const terminalEnv = buildTerminalEnv(
        process.env,
        Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
      );
      if (shellKind === 'wsl') {
        appendWslenv(terminalEnv, [
          { name: 'TESSERA_PANE_TOKEN' },
          { name: 'TESSERA_SESSION_ID' },
          { name: 'TESSERA_HOOK_PORT' },
          { name: 'TESSERA_OPENCODE_RESUME_ID' },
          { name: 'CODEX_HOME', path: true },
          { name: 'OPENCODE_CONFIG_DIR', path: true },
          { name: 'TERM' },
          { name: 'COLORTERM' },
          { name: 'TERM_PROGRAM' },
        ]);
      }
      const cols = normalizeTerminalDimension(options.cols, 80, MAX_TERMINAL_COLS);
      const rows = normalizeTerminalDimension(options.rows, 24, MAX_TERMINAL_ROWS);
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
      const handoffSessionId = options.launchSpec?.handoffSessionId;
      assertOpeningActive();
      if (handoffSessionId && !ownsTerminalHandoffLock(
        handoffSessionId,
        options.userId,
        options.terminalId,
      )) {
        throw new Error('The Codex terminal handoff was cancelled.');
      }
      terminalProcess = ptyFactory.spawn(shell.command, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: shell.cwd,
        env: terminalEnv,
        ...(getRuntimePlatform() === 'win32' ? { useConpty: false } : {}),
      });
      const processHandle = terminalProcess;
      traceTerminalStage('spawn:after', { terminalId: options.terminalId });
      logger.debug({ terminalId: options.terminalId }, 'Terminal PTY spawned');

      const generation = (this.generationByTerminal.get(key) ?? 0) + 1;
      this.generationByTerminal.set(key, generation);
      model = this.managerOptions.createHeadlessModel?.(cols, rows)
        ?? new TerminalHeadlessModel(cols, rows);
      const runtime: TerminalRuntime = {
        terminalId: options.terminalId,
        userId: options.userId,
        sessionId: options.sessionId ?? null,
        interruptInputPolicy: options.interruptInputPolicy ?? 'none',
        generation,
        sequence: 0,
        ended: false,
        cwd: shell.displayCwd ?? shell.cwd,
        shell: shell.command,
        appearanceChangePolicy: options.appearanceChangePolicy ?? 'live',
        resizeScrollbackPolicy: options.resizeScrollbackPolicy ?? 'native',
        canRestartForAppearance: options.canRestartForAppearance,
        appearanceRestartIntent: options.appearanceRestartIntent,
        appearanceRestartPending: false,
        process: processHandle,
        model,
        cols,
        rows,
        subscribers: new Map(),
        viewportOwner: null,
        outputBuffer: [],
        outputBufferSize: 0,
        pendingSend: [],
        pendingSendTimer: null,
        handoffSessionId,
        prefillPending: Boolean(options.launchSpec?.prefillInput),
        disposeSessionObservers: options.launchObserverDisposer
          ? [options.launchObserverDisposer]
          : [],
        retiredProviderSessionIds: new Set(),
        backgroundProviderSessionIds: new Set(),
        reboundFromSessionIds: new Set(),
        previewOwnerToken: options.previewOwnerToken,
      };
      if (options.appearance) {
        runtime.appearanceController = createTerminalAppearanceController(
          options.appearance,
          (reply) => processHandle.write(reply),
        );
      }
      this.terminals.set(key, runtime);
      if (runtime.sessionId) {
        this.clearTerminalReservation(runtime.userId, runtime.sessionId, runtime.terminalId);
        this.sessionBindings.set(
          this.getSessionKey(runtime.userId, runtime.sessionId),
          runtime.terminalId,
        );
        this.managerOptions.onSessionRuntimeStateChange?.({
          sessionId: runtime.sessionId,
          terminalId: runtime.terminalId,
          userId: runtime.userId,
          running: true,
        });
      }

      // 미지원 슬래시 명령 fallback: provider TUI가 기동된 뒤 입력창이
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
          prefillHardTimer = setTimeout(sendPrefill, AUTOMATED_RESPONSE_FRAGMENT_GRACE_MS);
          return;
        }
        prefillSent = true;
        runtime.prefillPending = false;
        clearPrefillTimers();
        // 개행은 자동 제출, 탭은 TUI 자동완성을 유발하므로 공백으로 치환한다
        // (자동 실행 방지 불변식). 사용자가 확인 후 직접 Enter를 눌러야 한다.
        const sanitized = prefillInput.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');
        try {
          processHandle.write(sanitized);
          runtime.cancelPrefill = undefined;
          logger.debug({ terminalId: options.terminalId }, 'Terminal prefill written');
          this.sendToConnection(options.connectionId, {
            type: 'terminal_prefill_written',
            terminalId: options.terminalId,
          });
        } catch (err) {
          // close()가 onExit보다 먼저 와 PTY가 이미 죽은 경우 write가 throw할 수 있다.
          // setTimeout 콜백에서 던지면 서버 프로세스가 죽으므로 조용히 무시한다.
          logger.debug({ terminalId: options.terminalId, err }, 'Terminal prefill write skipped (pty gone)');
          runtime.cancelPrefill = undefined;
          this.sendToConnection(options.connectionId, {
            type: 'terminal_prefill_cancelled',
            terminalId: options.terminalId,
            message: 'Terminal closed before the command could be prepared.',
          });
        }
      };
      if (prefillInput) {
        prefillHardTimer = setTimeout(sendPrefill, PREFILL_HARD_TIMEOUT_MS);
      }

      const deliverOutput = (data: string) => {
        if (data.length === 0) return;
        // replay 버퍼: 원본 청크 순서/내용 그대로 즉시 누적 — coalescing과 독립.
        this.appendBufferedOutput(runtime, data);
        runtime.model.write(data);

        // prefill 감지: 원본 청크 타이밍에 의존하므로 즉시 처리(WS 전송만 뒤에서 모은다).
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

        // WS 전송만 한 tick 모아 1회 전송(flood 완화).
        this.queueOutput(runtime, data);
      };
      runtime.resizeOutputTransaction = new TerminalResizeOutputTransaction({
        emit: deliverOutput,
      });

      processHandle.onData((rawData) => {
        const data = runtime.appearanceController?.consumeOutput(rawData) ?? rawData;
        runtime.resizeOutputTransaction?.accept(data);
      });

      processHandle.onExit((event) => {
        const pendingColorQueryData = runtime.appearanceController?.drain() ?? '';
        if (pendingColorQueryData) {
          runtime.resizeOutputTransaction?.accept(pendingColorQueryData);
        }
        clearPrefillTimers();
        this.finalizeRuntimeExit(runtime, key, event);
      });

      this.startSessionObserver(runtime);

      return runtime;
    } catch (error) {
      if (options.sessionId) {
        this.clearTerminalReservation(options.userId, options.sessionId, options.terminalId);
      }
      if (options.launchSpec?.handoffSessionId) {
        releaseTerminalHandoffByTerminal(options.userId, options.terminalId);
      }
      try {
        terminalProcess?.kill();
      } catch {
        // Spawn may have failed after allocating a partial native handle.
      }
      model?.dispose();
      if (this.terminals.get(key)?.process === terminalProcess) {
        this.terminals.delete(key);
      }
      revokePaneTokensForTerminal(options.terminalId);
      cleanupCodexOverlayForTerminal(options.terminalId);
      options.launchObserverDisposer?.();
      throw error;
    }
  }

  private async attachRuntime(
    runtime: TerminalRuntime,
    options: Pick<
      TerminalCreateOptions,
      'connectionId' | 'surfaceId' | 'cols' | 'rows' | 'appearance'
    >,
    reattached: boolean,
  ): Promise<void> {
    const subscriberKey = this.getSubscriberKey(options.connectionId, options.surfaceId);
    const subscriber: TerminalSubscriber = {
      connectionId: options.connectionId,
      surfaceId: options.surfaceId,
      ready: false,
      pendingFrames: [],
    };

    this.flushPendingOutput(runtime);
    const snapshotSeq = runtime.sequence;
    const fallbackSnapshot = runtime.outputBuffer.join('');
    runtime.subscribers.set(subscriberKey, subscriber);
    runtime.viewportOwner = subscriberKey;
    if (options.cols && options.rows) {
      this.resizeRuntime(runtime, options.cols, options.rows);
    }
    this.sendStarted(runtime, subscriber, reattached);
    const runtimeAppearance = runtime.appearanceController?.getAppearance();
    if (
      reattached
      && options.appearance
      && runtimeAppearance
      && (
        runtimeAppearance.mode !== options.appearance.mode
        || runtimeAppearance.foreground !== options.appearance.foreground
        || runtimeAppearance.background !== options.appearance.background
      )
    ) {
      this.setAppearance(
        runtime.terminalId,
        runtime.userId,
        subscriber.connectionId,
        subscriber.surfaceId,
        options.appearance,
      );
    }

    try {
      const snapshot = await resolveSnapshotWithTimeout(
        runtime.model,
        this.managerOptions.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
      );
      if (runtime.subscribers.get(subscriberKey) !== subscriber) return;
      this.sendToConnection(subscriber.connectionId, {
        type: 'terminal_snapshot',
        terminalId: runtime.terminalId,
        surfaceId: subscriber.surfaceId,
        generation: runtime.generation,
        seq: snapshotSeq,
        data: snapshot.data,
        cols: snapshot.cols,
        rows: snapshot.rows,
      });
    } catch (error) {
      if (runtime.subscribers.get(subscriberKey) !== subscriber) return;
      logger.warn({ error, terminalId: runtime.terminalId }, 'Terminal snapshot failed; using raw replay');
      this.sendToConnection(subscriber.connectionId, {
        type: 'terminal_snapshot',
        terminalId: runtime.terminalId,
        surfaceId: subscriber.surfaceId,
        generation: runtime.generation,
        seq: snapshotSeq,
        data: fallbackSnapshot,
        cols: normalizeTerminalDimension(options.cols, 80, MAX_TERMINAL_COLS),
        rows: normalizeTerminalDimension(options.rows, 24, MAX_TERMINAL_ROWS),
        fallback: true,
      });
    }

    if (runtime.subscribers.get(subscriberKey) !== subscriber) return;
    subscriber.ready = true;
    const pendingFrames = subscriber.pendingFrames;
    subscriber.pendingFrames = [];
    for (const frame of pendingFrames) {
      if (frame.seq > snapshotSeq) {
        this.sendOutput(runtime, subscriber, frame);
      }
    }
    if (subscriber.pendingExit) {
      this.sendExitToSubscriber(runtime, subscriber, subscriber.pendingExit);
      subscriber.pendingExit = undefined;
    } else if (runtime.exitEvent) {
      this.sendExitToSubscriber(runtime, subscriber, runtime.exitEvent);
    }
  }

  write(
    terminalId: string,
    userId: string,
    connectionId: string,
    surfaceId: string,
    data: string,
  ): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended) return;
    const subscriberKey = this.getSubscriberKey(connectionId, surfaceId);
    if (!runtime.subscribers.has(subscriberKey)) return;
    runtime.viewportOwner = subscriberKey;
    if (runtime.prefillPending && data.length > 0) {
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
        this.cancelPendingPrefill(
          runtime,
          'Terminal input arrived before the command was ready. Your draft was kept.',
        );
      }
    }
    if (classifyAutomatedTerminalResponse(data) === 'not-automated') {
      runtime.resizeOutputTransaction?.settle();
    }
    runtime.process.write(data);
    this.observeAgentInterruptInput(runtime, data);
  }

  private observeAgentInterruptInput(runtime: TerminalRuntime, data: string): void {
    const baseline = runtime.lastSessionState;
    if (
      data !== '\x1b'
      || runtime.interruptInputPolicy !== 'single-escape'
      || !runtime.sessionId
      || baseline?.status !== 'running'
      || baseline.hasWorkingSubagents
    ) {
      return;
    }

    this.clearInterruptInference(runtime);
    runtime.interruptInferenceTimer = setTimeout(() => {
      runtime.interruptInferenceTimer = undefined;
      this.inferInterrupt(runtime, baseline);
    }, this.managerOptions.interruptSettleMs ?? AGENT_INTERRUPT_SETTLE_MS);
    runtime.interruptInferenceTimer.unref?.();
  }

  setAppearance(
    terminalId: string,
    userId: string,
    connectionId: string,
    surfaceId: string,
    appearance: TerminalAppearance,
  ): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended) return;
    const subscriberKey = this.getSubscriberKey(connectionId, surfaceId);
    if (!runtime.subscribers.has(subscriberKey)) return;

    runtime.appearanceController ??= createTerminalAppearanceController(
      appearance,
      (reply) => runtime.process.write(reply),
    );
    const currentAppearance = runtime.appearanceController.getAppearance();
    const restartRequired = runtime.appearanceChangePolicy === 'restart'
      && currentAppearance.mode !== appearance.mode
      && !runtime.appearanceController.isDynamicColorSchemeSubscribed();
    if (!restartRequired) {
      runtime.appearanceController.updateAppearance(appearance);
    }
    runtime.appearanceRestartPending = restartRequired;
    this.broadcastAppearance(runtime, restartRequired);
  }

  refreshAppearanceRestartAvailability(sessionId: string, userId: string): void {
    const terminalId = this.sessionBindings.get(this.getSessionKey(userId, sessionId));
    if (!terminalId) return;
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended || !runtime.appearanceRestartPending) return;
    this.broadcastAppearance(runtime, true);
  }

  private broadcastAppearance(runtime: TerminalRuntime, restartRequired: boolean): void {
    const restartAllowed = restartRequired && (runtime.canRestartForAppearance?.() ?? false);
    const canonicalAppearance = runtime.appearanceController?.getAppearance();
    if (!canonicalAppearance) return;
    for (const subscriber of runtime.subscribers.values()) {
      this.sendToConnection(subscriber.connectionId, {
        type: 'terminal_appearance',
        terminalId: runtime.terminalId,
        surfaceId: subscriber.surfaceId,
        appearance: canonicalAppearance,
        restartRequired,
        restartAllowed,
        restartIntent: restartAllowed ? runtime.appearanceRestartIntent : undefined,
      });
    }
  }

  /** Route existing chat actions to a terminal-kind session without spawning a headless CLI. */
  submitSessionInput(sessionId: string, userId: string, data: string): boolean {
    const terminalId = this.sessionBindings.get(this.getSessionKey(userId, sessionId));
    if (!terminalId) return false;
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended || data.length === 0) return false;
    runtime.resizeOutputTransaction?.settle();
    runtime.process.write(`${data.replace(/[\r\n\t]+/g, ' ')}\r`);
    return true;
  }

  /** 살아있는 소유 runtime의 상태만 수락한다. false = 죽었거나 미소유인 pane의
   *  늦은 hook curl — 캐시도 브로드캐스트도 하면 안 되는 유령 상태다. */
  recordSessionState(message: TerminalSessionStateMessage, userId: string): boolean {
    const runtime = this.getOwnedTerminal(message.terminalId, userId);
    if (!runtime || runtime.sessionId !== message.sessionId || runtime.ended) return false;
    this.clearInterruptInference(runtime);
    if (
      runtime.interruptInferredAt
      && message.status === 'running'
      && message.hookEvent !== 'UserPromptSubmit'
      && Date.now() - runtime.interruptInferredAt <= INTERRUPTED_LATE_RUNNING_SUPPRESSION_MS
    ) {
      return false;
    }
    runtime.interruptInferredAt = undefined;
    runtime.lastSessionState = message;
    return true;
  }

  getSessionStatesForUser(userId: string): TerminalSessionStateMessage[] {
    return [...this.terminals.values()]
      .filter((runtime) => runtime.userId === userId && !runtime.ended && runtime.lastSessionState)
      .map((runtime) => runtime.lastSessionState!);
  }

  getSessionStateForSession(sessionId: string, userId: string): TerminalSessionStateMessage | null {
    for (const runtime of this.terminals.values()) {
      if (
        runtime.userId === userId
        && runtime.sessionId === sessionId
        && !runtime.ended
        && runtime.lastSessionState
      ) {
        return runtime.lastSessionState;
      }
    }
    return null;
  }

  resize(
    terminalId: string,
    userId: string,
    connectionId: string,
    surfaceId: string,
    cols: number,
    rows: number,
    claim = false,
  ): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended) return;
    const subscriberKey = this.getSubscriberKey(connectionId, surfaceId);
    if (!runtime.subscribers.has(subscriberKey)) return;
    if (claim || runtime.viewportOwner === null) {
      runtime.viewportOwner = subscriberKey;
    }
    if (runtime.viewportOwner !== subscriberKey) return;
    this.resizeRuntime(runtime, cols, rows);
  }

  detach(terminalId: string, userId: string, connectionId: string, surfaceId: string): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime) return;
    const subscriberKey = this.getSubscriberKey(connectionId, surfaceId);
    runtime.subscribers.delete(subscriberKey);
    if (runtime.viewportOwner === subscriberKey) {
      runtime.viewportOwner = runtime.subscribers.keys().next().value ?? null;
    }
  }

  detachConnection(connectionId: string): void {
    this.disconnectedConnections.add(connectionId);
    for (const runtime of this.terminals.values()) {
      for (const [subscriberKey, subscriber] of runtime.subscribers) {
        if (subscriber.connectionId !== connectionId) continue;
        runtime.subscribers.delete(subscriberKey);
        if (runtime.viewportOwner === subscriberKey) {
          runtime.viewportOwner = null;
        }
      }
      if (runtime.viewportOwner === null) {
        runtime.viewportOwner = runtime.subscribers.keys().next().value ?? null;
      }
    }
  }

  registerConnection(connectionId: string): void {
    this.disconnectedConnections.delete(connectionId);
  }

  async close(terminalId: string, userId: string): Promise<void> {
    const key = this.getKey(userId, terminalId);
    const existing = this.getOwnedTerminal(terminalId, userId);
    if (existing) {
      this.closeRuntime(existing);
      return;
    }

    const opening = this.openingByTerminalKey.get(key);
    if (!opening) return;
    this.cancelledOpeningKeys.add(key);
    releaseTerminalHandoffByTerminal(userId, terminalId);
    try {
      await opening;
    } catch {
      // Failed spawns already clean their token/overlay and have nothing to kill.
    }
  }

  /** Close only when this preview token created the runtime or owns its in-flight spawn. */
  async releasePreview(
    requestedTerminalId: string,
    userId: string,
    sessionId: string | null | undefined,
    previewOwnerToken: string,
  ): Promise<void> {
    const terminalId = this.resolveTerminalId(userId, requestedTerminalId, sessionId);
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (runtime) {
      if (shouldReleasePreviewRuntime({
        runtimeOwnerToken: runtime.previewOwnerToken,
        previewOwnerToken,
      })) this.closeRuntime(runtime);
      return;
    }

    const key = this.getKey(userId, terminalId);
    if (!shouldReleasePreviewRuntime({
      runtimeOwnerToken: this.openingPreviewOwnerByTerminalKey.get(key),
      previewOwnerToken,
    })) return;
    await this.close(terminalId, userId);
  }

  private closeRuntime(runtime: TerminalRuntime): void {
    if (runtime.ended || runtime.closing) return;
    const { terminalId, userId } = runtime;
    runtime.closing = true;
    this.cancelPendingPrefill(
      runtime,
      'The terminal was closed before the command could be entered. Your draft was kept.',
    );
    const key = this.getKey(userId, terminalId);
    let killSignalled = false;
    try {
      runtime.process.kill();
      killSignalled = true;
    } catch (error) {
      logger.warn({ error, terminalId }, 'Terminal close signal failed; awaiting exit confirmation');
    }
    if (killSignalled && !runtime.handoffSessionId) {
      this.finalizeRuntimeExit(runtime, key, { exitCode: 0 });
      return;
    }
    if (this.terminals.get(key) === runtime) {
      this.scheduleCloseWatchdog(
        runtime,
        key,
        this.managerOptions.closeExitGraceMs ?? CLOSE_EXIT_GRACE_MS,
      );
    }
  }

  private cancelPendingPrefill(runtime: TerminalRuntime, message: string): void {
    if (!runtime.prefillPending) return;
    this.clearAutomatedResponseCandidate(runtime);
    runtime.cancelPrefill?.();
    runtime.cancelPrefill = undefined;
    runtime.prefillPending = false;
    const notifiedConnections = new Set<string>();
    for (const subscriber of runtime.subscribers.values()) {
      if (notifiedConnections.has(subscriber.connectionId)) continue;
      notifiedConnections.add(subscriber.connectionId);
      this.sendToConnection(subscriber.connectionId, {
        type: 'terminal_prefill_cancelled',
        terminalId: runtime.terminalId,
        message,
      });
    }
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
        logger.error({ terminalId: runtime.terminalId }, 'Cannot confirm closing terminal exit without a PID');
        return;
      }
      const alive = (this.managerOptions.processIsAlive ?? isProcessAlive)(pid as number);
      if (!alive) {
        this.finalizeRuntimeExit(runtime, key, { exitCode: 0 });
        return;
      }
      runtime.closeWatchdogChecks = (runtime.closeWatchdogChecks ?? 0) + 1;
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

  private finalizeRuntimeExit(
    runtime: TerminalRuntime,
    key: string,
    event: { exitCode: number; signal?: number },
  ): void {
    if (runtime.ended) return;
    const isCurrent = this.terminals.get(key) === runtime;
    if (runtime.closeWatchdog) {
      clearTimeout(runtime.closeWatchdog);
      runtime.closeWatchdog = undefined;
    }
    this.clearAutomatedResponseCandidate(runtime);
    this.clearInterruptInference(runtime);
    this.cancelPendingPrefill(
      runtime,
      'The terminal exited before the command could be entered. Your draft was kept.',
    );
    runtime.ended = true;
    runtime.exitEvent = event;
    this.disposeSessionObserver(runtime);
    runtime.resizeOutputTransaction?.dispose();
    this.flushPendingOutput(runtime);
    if (isCurrent) {
      this.terminals.delete(key);
      this.clearSessionBinding(runtime);
      revokePaneTokensForTerminal(runtime.terminalId);
      cleanupCodexOverlayForTerminal(runtime.terminalId);
      if (runtime.sessionId) {
        this.managerOptions.onSessionRuntimeStateChange?.({
          sessionId: runtime.sessionId,
          terminalId: runtime.terminalId,
          userId: runtime.userId,
          running: false,
        });
      }
    }
    if (runtime.handoffSessionId && ownsTerminalHandoffLock(
      runtime.handoffSessionId,
      runtime.userId,
      runtime.terminalId,
    )) {
      releaseTerminalHandoffByTerminal(runtime.userId, runtime.terminalId);
    }
    runtime.model?.dispose();
    this.sendExit(runtime, event);
  }

  private startSessionObserver(runtime: TerminalRuntime): void {
    if (!runtime.sessionId || !this.observeSessionRuntime) return;

    const observedSessionId = runtime.sessionId;

    void Promise.resolve().then(() => this.observeSessionRuntime?.({
      cwd: runtime.cwd,
      generation: runtime.generation,
      sessionId: observedSessionId,
      terminalId: runtime.terminalId,
      userId: runtime.userId,
    })).then((dispose) => {
      if (!dispose) return;
      if (runtime.ended || runtime.sessionId !== observedSessionId) {
        dispose();
        return;
      }
      runtime.disposeSessionObservers.push(dispose);
    }).catch((error) => {
      logger.warn({ error, sessionId: runtime.sessionId, terminalId: runtime.terminalId }, 'Terminal session observer failed');
    });
  }

  private disposeSessionObserver(runtime: TerminalRuntime): void {
    const disposers = (runtime.disposeSessionObservers ?? []).splice(0);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        logger.warn({ error, sessionId: runtime.sessionId, terminalId: runtime.terminalId }, 'Terminal session observer cleanup failed');
      }
    }
  }

  async closeAllForUser(userId: string): Promise<void> {
    const ownedTerminalIds = new Set([...this.terminals.values()]
      .filter((runtime) => runtime.userId === userId)
      .map((runtime) => runtime.terminalId));
    for (const key of this.openingByTerminalKey.keys()) {
      const prefix = `${userId}:`;
      if (key.startsWith(prefix)) ownedTerminalIds.add(key.slice(prefix.length));
    }
    await Promise.all([...ownedTerminalIds].map((terminalId) => this.close(terminalId, userId)));
  }

  async closeSession(sessionId: string, userId: string): Promise<void> {
    const sessionKey = this.getSessionKey(userId, sessionId);
    const boundTerminalId = this.sessionBindings.get(sessionKey);
    if (boundTerminalId) {
      await this.close(boundTerminalId, userId);
      return;
    }

    // Session deletion can race an async native PTY load/spawn. Wait for that
    // one in-flight create and immediately tear it down instead of orphaning it.
    const opening = this.openingTerminals.get(this.getSessionOpeningKey(userId, sessionId));
    if (!opening) {
      this.clearTerminalReservation(userId, sessionId);
      return;
    }
    try {
      const runtime = await opening;
      this.closeRuntime(runtime);
    } catch {
      // Failed spawns already clean their token/overlay and have nothing to kill.
    }
  }

  preventSessionOpen(sessionId: string, userId: string): void {
    const sessionKey = this.getSessionKey(userId, sessionId);
    this.blockedSessions.add(sessionKey);
    this.clearTerminalReservation(userId, sessionId);
  }

  allowSessionOpen(sessionId: string, userId: string): void {
    this.blockedSessions.delete(this.getSessionKey(userId, sessionId));
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    const openings = [...new Set(this.openingTerminals.values())];
    await Promise.allSettled(openings);
    const runtimes = [...this.terminals.values()];
    for (const runtime of runtimes) {
      this.closeRuntime(runtime);
    }
    this.terminalReservations.clear();
    this.reservedSessionByTerminalKey.clear();
  }

  getRuntimeSummary(): { activeCount: number; sessionCount: number } {
    const runtimes = [...this.terminals.values()].filter((runtime) => !runtime.ended);
    const activeKeys = new Set(runtimes.map((runtime) => this.getKey(runtime.userId, runtime.terminalId)));
    const openingEntries = [...this.openingByTerminalKey.keys()]
      .filter((key) => !activeKeys.has(key));
    return {
      activeCount: runtimes.length + openingEntries.length,
      sessionCount: runtimes.filter((runtime) => runtime.sessionId !== null).length
        + openingEntries.filter((key) => this.openingSessionByTerminalKey.get(key) != null).length,
    };
  }

  getActiveSessionIds(userId?: string): Set<string> {
    return new Set(
      [...this.terminals.values()]
        .filter((runtime) => !runtime.ended && runtime.sessionId !== null)
        .filter((runtime) => userId === undefined || runtime.userId === userId)
        .map((runtime) => runtime.sessionId!),
    );
  }

  getSessionReboundsForUser(userId: string): Array<{
    previousSessionId: string;
    sessionId: string;
    terminalId: string;
  }> {
    const activeRuntimes = [...this.terminals.values()]
      .filter((runtime) => runtime.userId === userId && !runtime.ended && runtime.sessionId);
    const activeSessionIds = new Set(activeRuntimes.map((runtime) => runtime.sessionId!));
    return activeRuntimes
      .flatMap((runtime) => [...runtime.reboundFromSessionIds].map((previousSessionId) => ({
        previousSessionId,
        sessionId: runtime.sessionId!,
        terminalId: runtime.terminalId,
      })))
      .filter((rebound) => !activeSessionIds.has(rebound.previousSessionId));
  }

  getSessionIdForTerminal(terminalId: string, userId: string): string | null {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    return runtime && !runtime.ended ? runtime.sessionId : null;
  }

  isProviderSessionIdentityRetired(
    terminalId: string,
    userId: string,
    providerSessionId: string,
  ): boolean {
    return this.getOwnedTerminal(terminalId, userId)?.retiredProviderSessionIds
      .has(providerSessionId) ?? false;
  }

  markProviderSessionIdentityBackground(
    terminalId: string,
    userId: string,
    providerSessionId: string,
  ): boolean {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended || runtime.providerSessionId === providerSessionId) return false;
    runtime.backgroundProviderSessionIds.add(providerSessionId);
    return true;
  }

  isProviderSessionIdentityBackground(
    terminalId: string,
    userId: string,
    providerSessionId: string,
  ): boolean {
    return this.getOwnedTerminal(terminalId, userId)?.backgroundProviderSessionIds
      .has(providerSessionId) ?? false;
  }

  activateProviderSessionIdentity(
    terminalId: string,
    userId: string,
    providerSessionId: string,
    previousProviderSessionId?: string,
  ): boolean {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended || runtime.retiredProviderSessionIds.has(providerSessionId)) {
      return false;
    }
    if (runtime.providerSessionId && runtime.providerSessionId !== providerSessionId) {
      runtime.retiredProviderSessionIds.add(runtime.providerSessionId);
    }
    if (previousProviderSessionId && previousProviderSessionId !== providerSessionId) {
      runtime.retiredProviderSessionIds.add(previousProviderSessionId);
    }
    runtime.backgroundProviderSessionIds.delete(providerSessionId);
    runtime.providerSessionId = providerSessionId;
    return true;
  }

  /** Keep one live PTY while moving its ownership from a parent conversation
   *  to the provider-created child conversation. */
  rebindSession(
    terminalId: string,
    userId: string,
    sourceSessionId: string,
    destinationSessionId: string,
  ): boolean {
    if (sourceSessionId === destinationSessionId) return true;
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended || runtime.sessionId !== sourceSessionId) return false;

    const destinationKey = this.getSessionKey(userId, destinationSessionId);
    const existingDestination = this.sessionBindings.get(destinationKey);
    if (existingDestination && existingDestination !== terminalId) return false;

    this.disposeSessionObserver(runtime);
    this.clearSessionBinding(runtime);
    runtime.lastSessionState = undefined;
    runtime.sessionId = destinationSessionId;
    runtime.reboundFromSessionIds.add(sourceSessionId);
    this.sessionBindings.set(destinationKey, terminalId);
    this.managerOptions.onSessionRuntimeRebound?.({
      previousSessionId: sourceSessionId,
      sessionId: destinationSessionId,
      terminalId,
      userId,
    });
    this.startSessionObserver(runtime);
    return true;
  }

  resolveTerminalId(userId: string, requestedTerminalId: string, sessionId?: string | null): string {
    if (!sessionId) return requestedTerminalId;
    const sessionKey = this.getSessionKey(userId, sessionId);
    return this.sessionBindings.get(sessionKey)
      ?? this.terminalReservations.get(sessionKey)
      ?? requestedTerminalId;
  }

  reserveTerminalId(userId: string, requestedTerminalId: string, sessionId: string): string {
    const sessionKey = this.getSessionKey(userId, sessionId);
    const existing = this.sessionBindings.get(sessionKey) ?? this.terminalReservations.get(sessionKey);
    if (existing) return existing;

    let terminalId = requestedTerminalId;
    while (true) {
      const key = this.getKey(userId, terminalId);
      const runtime = this.terminals.get(key);
      const openingSessionId = this.openingSessionByTerminalKey.get(key);
      const reservedSessionKey = this.reservedSessionByTerminalKey.get(key);
      if (
        (!runtime || runtime.sessionId === sessionId)
        && (openingSessionId === undefined || openingSessionId === sessionId)
        && (reservedSessionKey === undefined || reservedSessionKey === sessionKey)
      ) break;
      terminalId = `${requestedTerminalId}-${randomUUID()}`;
    }
    this.terminalReservations.set(sessionKey, terminalId);
    this.reservedSessionByTerminalKey.set(this.getKey(userId, terminalId), sessionKey);
    return terminalId;
  }

  releaseTerminalReservation(
    userId: string,
    sessionId: string,
    expectedTerminalId?: string,
  ): void {
    this.clearTerminalReservation(userId, sessionId, expectedTerminalId);
  }

  hasOrIsOpening(
    terminalId: string,
    userId: string,
    sessionId?: string | null,
  ): boolean {
    const key = this.getKey(userId, terminalId);
    const runtime = this.terminals.get(key);
    return Boolean(runtime && (!sessionId || runtime.sessionId === sessionId))
      || this.openingTerminals.has(this.getOpeningKey(userId, terminalId, sessionId));
  }

  private getOwnedTerminal(terminalId: string, userId: string): TerminalRuntime | null {
    const runtime = this.terminals.get(this.getKey(userId, terminalId));
    if (!runtime) return null;
    if (runtime.userId !== userId) {
      logger.warn({ terminalId, userId }, 'Rejected terminal access for non-owner');
      return null;
    }
    return runtime;
  }

  private getKey(userId: string, terminalId: string): string {
    return `${userId}:${terminalId}`;
  }

  private getSessionKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  private clearTerminalReservation(
    userId: string,
    sessionId: string,
    expectedTerminalId?: string,
  ): void {
    const sessionKey = this.getSessionKey(userId, sessionId);
    const terminalId = this.terminalReservations.get(sessionKey);
    if (!terminalId || (expectedTerminalId && terminalId !== expectedTerminalId)) return;
    this.terminalReservations.delete(sessionKey);
    const terminalKey = this.getKey(userId, terminalId);
    if (this.reservedSessionByTerminalKey.get(terminalKey) === sessionKey) {
      this.reservedSessionByTerminalKey.delete(terminalKey);
    }
  }

  private getSessionOpeningKey(userId: string, sessionId: string): string {
    return `session:${this.getSessionKey(userId, sessionId)}`;
  }

  private getOpeningKey(
    userId: string,
    terminalId: string,
    sessionId?: string | null,
  ): string {
    return sessionId
      ? this.getSessionOpeningKey(userId, sessionId)
      : `terminal:${this.getKey(userId, terminalId)}`;
  }

  private getSubscriberKey(connectionId: string, surfaceId: string): string {
    return `${connectionId}:${surfaceId}`;
  }

  private clearSessionBinding(runtime: TerminalRuntime): void {
    if (!runtime.sessionId) return;
    const sessionKey = this.getSessionKey(runtime.userId, runtime.sessionId);
    if (this.sessionBindings.get(sessionKey) === runtime.terminalId) {
      this.sessionBindings.delete(sessionKey);
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

  private sendStarted(
    runtime: TerminalRuntime,
    subscriber: TerminalSubscriber,
    reattached: boolean,
  ): void {
    this.sendToConnection(subscriber.connectionId, {
      type: 'terminal_started',
      terminalId: runtime.terminalId,
      surfaceId: subscriber.surfaceId,
      generation: runtime.generation,
      cwd: runtime.cwd,
      shell: runtime.shell,
      reattached,
      appearance: runtime.appearanceController?.getAppearance(),
    });
  }

  private sendOutput(
    runtime: TerminalRuntime,
    subscriber: TerminalSubscriber,
    frame: TerminalOutputFrame,
  ): void {
    this.sendToConnection(subscriber.connectionId, {
      type: 'terminal_output',
      terminalId: runtime.terminalId,
      surfaceId: subscriber.surfaceId,
      generation: runtime.generation,
      seq: frame.seq,
      data: frame.data,
    });
  }

  private sendExit(
    runtime: TerminalRuntime,
    event: { exitCode: number; signal?: number },
  ): void {
    for (const subscriber of runtime.subscribers.values()) {
      if (!subscriber.ready) {
        subscriber.pendingExit = event;
        continue;
      }
      this.sendExitToSubscriber(runtime, subscriber, event);
    }
  }

  private sendExitToSubscriber(
    runtime: TerminalRuntime,
    subscriber: TerminalSubscriber,
    event: { exitCode: number; signal?: number },
  ): void {
    this.sendToConnection(subscriber.connectionId, {
      type: 'terminal_exit',
      terminalId: runtime.terminalId,
      surfaceId: subscriber.surfaceId,
      generation: runtime.generation,
      exitCode: event.exitCode,
      signal: event.signal,
    });
  }

  private resizeRuntime(runtime: TerminalRuntime, cols: number, rows: number): void {
    const normalizedCols = normalizeTerminalDimension(cols, 80, MAX_TERMINAL_COLS);
    const normalizedRows = normalizeTerminalDimension(rows, 24, MAX_TERMINAL_ROWS);
    if (runtime.cols === normalizedCols && runtime.rows === normalizedRows) return;
    if (runtime.resizeScrollbackPolicy === 'preserve-on-ed3') {
      runtime.resizeOutputTransaction?.begin();
    }
    runtime.process.resize(normalizedCols, normalizedRows);
    runtime.model.resize(normalizedCols, normalizedRows);
    runtime.cols = normalizedCols;
    runtime.rows = normalizedRows;
  }

  private inferInterrupt(
    runtime: TerminalRuntime,
    baseline: TerminalSessionStateMessage,
  ): void {
    if (
      runtime.ended
      || runtime.closing
      || !runtime.sessionId
      || runtime.lastSessionState !== baseline
      || baseline.status !== 'running'
      || baseline.hasWorkingSubagents
    ) {
      return;
    }
    const stateAt = Date.now();
    const message: TerminalSessionStateMessage = {
      type: 'session_state',
      sessionId: runtime.sessionId,
      terminalId: runtime.terminalId,
      status: 'idle',
      hookEvent: 'InterruptFallback',
      stateAt,
    };
    runtime.interruptInferredAt = stateAt;
    runtime.lastSessionState = message;
    this.managerOptions.onSessionStateChange?.({
      message,
      userId: runtime.userId,
    });
  }

  private clearInterruptInference(runtime: TerminalRuntime): void {
    if (runtime.interruptInferenceTimer) {
      clearTimeout(runtime.interruptInferenceTimer);
      runtime.interruptInferenceTimer = undefined;
    }
  }

  // 코얼레싱 버퍼에 청크를 쌓고, 예약된 flush가 없으면 setImmediate 1개를 건다.
  // 같은 tick(poll 단계)에 도착한 모든 청크가 하나의 terminal_output로 합쳐진다.
  private queueOutput(runtime: TerminalRuntime, data: string): void {
    runtime.pendingSend.push(data);
    if (runtime.pendingSendTimer) return;
    runtime.pendingSendTimer = setImmediate(() => {
      this.flushPendingOutput(runtime);
    });
  }

  // pending 청크를 하나의 data로 이어붙여 1회 전송한다. onExit/close에서 직접 호출하면
  // 예약된 setImmediate를 취소하고 마지막 출력을 내보낸다(스키마는 그대로 유지).
  private flushPendingOutput(runtime: TerminalRuntime): void {
    if (runtime.pendingSendTimer) {
      clearImmediate(runtime.pendingSendTimer);
      runtime.pendingSendTimer = null;
    }
    if (runtime.pendingSend.length === 0) return;
    const data = runtime.pendingSend.join('');
    runtime.pendingSend = [];
    const frame = { seq: ++runtime.sequence, data };
    for (const subscriber of runtime.subscribers.values()) {
      if (subscriber.ready) {
        this.sendOutput(runtime, subscriber, frame);
      } else {
        subscriber.pendingFrames.push(frame);
      }
    }
  }

  private appendBufferedOutput(runtime: TerminalRuntime, data: string): void {
    runtime.outputBuffer.push(data);
    runtime.outputBufferSize += data.length;

    // Drop complete PTY chunks only. Cutting through a chunk can begin fallback
    // replay in the middle of a control sequence and corrupt a fresh xterm.
    while (runtime.outputBufferSize > MAX_REPLAY_BUFFER_CHARS && runtime.outputBuffer.length > 1) {
      const first = runtime.outputBuffer.shift();
      if (first) runtime.outputBufferSize -= first.length;
    }
  }
}
