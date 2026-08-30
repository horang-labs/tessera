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
import { revokePaneToken, revokePaneTokensForTerminal } from './pane-token-registry';
import { cleanupCodexOverlayForTerminal } from './codex-overlay';
import { cleanupCodexOverlayInWsl } from './codex-overlay-wsl';
import {
  TerminalHeadlessModel,
  type TerminalHeadlessSnapshot,
} from './terminal-headless-model';
import { normalizeTerminalColorEnv } from './terminal-color-env';
import { createTerminalAppearanceController } from './terminal-appearance-controller';
import {
  createTerminalDeviceQueryController,
  formatTerminalDeviceQueryReply,
  type TerminalDeviceQueryKind,
} from './terminal-device-query-controller';
import {
  ownsTerminalHandoffLock,
  releaseTerminalHandoffByTerminal,
} from './terminal-handoff-lock';
import type {
  TerminalCreateOptions,
  TerminalAppearance,
  TerminalProcessHandle,
  TerminalPtyFactory,
  TerminalResolvedShell,
  TerminalShellKind,
} from './types';
import {
  bracketSemanticPrompt,
  isTerminalNamedKey,
  normalizeSemanticPrompt,
  terminalNamedKeySequence,
  type TerminalNamedKey,
} from './session-control-input';

export type { TerminalNamedKey } from './session-control-input';
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
const MAX_SESSION_SCREEN_CHARS = 64_000;
const MAX_SESSION_LIFECYCLE_PREVIEW_CHARS = 2_000;
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
// Stand-ins for the client that a detached runtime does not have. No connection
// answers to them, so the messages addressed here are dropped rather than sent.
const DETACHED_CONNECTION_ID = 'detached';
const DETACHED_SURFACE_ID = 'detached';
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
      if (v === undefined) delete nextEnv[k];
      else nextEnv[k] = v;
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
  runtimeStateAt: number;
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
  deviceQueryController: ReturnType<typeof createTerminalDeviceQueryController>;
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
  restoresProviderSession?: boolean;
  semanticPromptPending?: boolean;
  semanticPromptSubmissions: Map<string, {
    sessionId: string;
    text: string;
    promise: Promise<TerminalSessionSnapshot>;
  }>;
  acceptedSemanticPrompts: Map<string, {
    sessionId: string;
    text: string;
    snapshot: TerminalSessionSnapshot;
  }>;
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
  detectConversationReset?: TerminalCreateOptions['detectConversationReset'];
  conversationResetScanTimer?: ReturnType<typeof setTimeout>;
  conversationResetHandledProviderSessionIds: Set<string>;
  providerSessionId?: string;
  retiredProviderSessionIds: Set<string>;
  backgroundProviderSessionIds: Set<string>;
  reboundFromSessionIds: Set<string>;
  previewOwnerToken?: string;
  onRuntimeExit?: TerminalCreateOptions['onRuntimeExit'];
  pendingSessionSnapshots: Set<Promise<void>>;
}

export type TerminalSessionRuntimeState =
  | 'starting'
  | 'idle'
  | 'running'
  | 'input-required'
  | 'turn-complete'
  | 'exited';

export interface TerminalSessionSnapshot {
  screen: string;
  cols: number | null;
  rows: number | null;
  alternateScreen: boolean;
  outputSequence: number;
  terminalId: string | null;
  runtimeState: TerminalSessionRuntimeState;
  stateAt: number | null;
  lifecyclePreview?: string;
}

export type TerminalSessionWaitCondition =
  | 'running'
  | 'turn-complete'
  | 'input-required'
  | 'runtime-exit';

interface TerminalSessionWaiter {
  condition: TerminalSessionWaitCondition;
  resolve: (snapshot: TerminalSessionSnapshot) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** The runtime only needs these members; tests can inject a stub model. */
export type TerminalHeadlessModelLike = Pick<
  TerminalHeadlessModel,
  'write' | 'resize' | 'snapshot' | 'readVisibleText' | 'dispose'
> & Partial<Pick<
  TerminalHeadlessModel,
  'whenSettled' | 'cursorPosition' | 'isAlternateScreen'
>>;

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
  /** Delay between a semantic bracketed paste and its submit key. */
  semanticPromptSubmitDelayMs?: number;
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
  /** The agent running in this PTY reset its conversation in place. */
  onTerminalConversationReset?: (state: {
    terminalId: string;
    userId: string;
  }) => void;
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

/**
 * Idle gap before re-reading the screen for a conversation reset. Long enough
 * that a repaint has settled into one scan, short enough to feel immediate.
 */
const CONVERSATION_RESET_SCAN_MS = 250;

async function resolveSnapshotWithTimeout(
  model: TerminalHeadlessModelLike,
  timeoutMs: number,
): Promise<TerminalHeadlessSnapshot> {
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
  const existing = (env.WSLENV ?? '').split(':').filter((entry) => (
    Boolean(entry) && env[entry.split('/')[0]] !== undefined
  ));
  const byName = new Map(existing.map((entry) => [entry.split('/')[0], entry]));
  for (const entry of entries) {
    if (env[entry.name] === undefined) continue;
    byName.set(entry.name, `${entry.name}${entry.path ? '/p' : ''}`);
  }
  if (byName.size > 0) env.WSLENV = [...byName.values()].join(':');
  else delete env.WSLENV;
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

export type TerminalLaunchRuntimeState = 'unowned' | 'opening' | 'spawned';

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
  private readonly sessionWaiters = new Map<string, Set<TerminalSessionWaiter>>();
  private readonly openingSessionObservations = new Map<string, {
    terminalId: string;
    stateAt: number;
  }>();
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
      this.disposeUnspawnedLaunch(options);
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
        this.recordOpeningSession(resolvedOptions);
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
          this.clearOpeningSession(resolvedOptions);
          this.cancelledOpeningKeys.delete(key);
        }).catch(() => {});
      }

      try {
        runtime = await opening;
      } catch (error) {
        if (resolvedOptions.sessionId) {
          this.notifySessionWithoutRuntime(
            resolvedOptions.sessionId,
            resolvedOptions.userId,
            resolvedOptions.terminalId,
          );
        }
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

  /**
   * Start a runtime the server owns, with no surface attached to it. Every
   * other runtime begins with a client message; this one begins with work the
   * server decided to do, and a surface may attach to it later or never.
   *
   * Resolves once the PTY is running, so a caller that must not be blocked by
   * it should not await. Rejects if the runtime cannot start.
   */
  async startDetached(
    options: Omit<TerminalCreateOptions, 'connectionId' | 'surfaceId'>,
  ): Promise<void> {
    if (this.shuttingDown) {
      this.disposeUnspawnedLaunch(options);
      throw new Error('Terminal host is shutting down.');
    }

    const key = this.getKey(options.userId, options.terminalId);
    const openingKey = this.getOpeningKey(
      options.userId,
      options.terminalId,
      options.sessionId,
    );
    const ownedRuntime = this.terminals.get(key);
    const ownedOpening = this.openingTerminals.get(openingKey);
    if (
      (ownedRuntime && (!options.sessionId || ownedRuntime.sessionId === options.sessionId))
      || ownedOpening
    ) {
      this.disposeSupersededLaunch(options);
      if (ownedOpening) await ownedOpening;
      return;
    }
    if (this.terminals.has(key) || this.openingByTerminalKey.has(key)) {
      this.disposeUnspawnedLaunch(options);
      throw new Error('The Session already has a live PTY runtime.');
    }

    const resolvedOptions: TerminalCreateOptions = {
      ...options,
      connectionId: DETACHED_CONNECTION_ID,
      surfaceId: DETACHED_SURFACE_ID,
    };
    // Registered the same way create() registers its own, so a surface that
    // attaches while this is still starting awaits this PTY instead of
    // spawning a second one for the same terminal.
    this.cancelledOpeningKeys.delete(key);
    this.recordOpeningSession(resolvedOptions);
    const opening = this.spawnRuntime(resolvedOptions, key);
    this.openingTerminals.set(openingKey, opening);
    this.openingByTerminalKey.set(key, opening);
    this.openingSessionByTerminalKey.set(key, resolvedOptions.sessionId ?? null);
    void opening.finally(() => {
      if (this.openingTerminals.get(openingKey) === opening) {
        this.openingTerminals.delete(openingKey);
      }
      if (this.openingByTerminalKey.get(key) === opening) {
        this.openingByTerminalKey.delete(key);
        this.openingSessionByTerminalKey.delete(key);
      }
      this.clearOpeningSession(resolvedOptions);
      this.cancelledOpeningKeys.delete(key);
    }).catch(() => {});

    try {
      await opening;
    } catch (error) {
      if (resolvedOptions.sessionId) {
        this.notifySessionWithoutRuntime(
          resolvedOptions.sessionId,
          resolvedOptions.userId,
          resolvedOptions.terminalId,
        );
      }
      throw error;
    }
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
      if (options.prepareLaunch) {
        traceTerminalStage('prepare-launch:before', { terminalId: options.terminalId });
        await options.prepareLaunch();
        assertOpeningActive();
        traceTerminalStage('prepare-launch:after', { terminalId: options.terminalId });
      }
      // A resolved shell already names its own program, argv, and directory, so
      // the cwd allowlist and the shell wrapping below have nothing left to do.
      let shellKind: TerminalShellKind | undefined;
      let shell: TerminalResolvedShell;
      if (options.resolvedShell) {
        shell = options.resolvedShell;
      } else {
        traceTerminalStage('resolve-cwd:before', { terminalId: options.terminalId });
        const cwdResolution = resolveAllowedTerminalCwd({
          cwd: options.launchSpec?.cwd ?? options.cwd,
          sessionId: options.sessionId,
        });
        traceTerminalStage('resolve-cwd:after', { terminalId: options.terminalId, cwdResolution });
        logger.debug({ terminalId: options.terminalId, cwdResolution }, 'Terminal cwd resolved');
        if (!cwdResolution.ok) {
          throw new Error(cwdResolution.message);
        }
        traceTerminalStage('resolve-shell-kind:before', { terminalId: options.terminalId });
        shellKind = await this.resolveShellKind(options);
        assertOpeningActive();
        traceTerminalStage('resolve-shell-kind:after', { terminalId: options.terminalId, shellKind });
        logger.debug({ terminalId: options.terminalId, shellKind }, 'Terminal shell kind resolved');
        traceTerminalStage('resolve-shell:before', { terminalId: options.terminalId });
        shell = resolveTerminalShell({
          cwd: cwdResolution.cwd,
          shellKind,
          launchSpec: options.launchSpec,
        });
      }
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
      // launchEnvFactory는 opening 윈도우 안에서 해석한다 — 게스트 오버레이 생성처럼
      // 느린 준비가 close_session 취소(cancelledOpeningKeys)와 중복 create 방지
      // (openingTerminals)의 보호를 받게 하기 위함. 실패는 create()의 catch가
      // terminal_error로 표면화한다.
      const launchEnv = options.launchEnv
        ?? (options.launchEnvFactory ? await options.launchEnvFactory() : undefined);
      assertOpeningActive();
      const extraEnv: Record<string, string | undefined> = {
        ...(options.paneToken
          ? {
              TESSERA_PANE_TOKEN: options.paneToken,
              TESSERA_SESSION_ID: options.sessionId ?? '',
              TESSERA_HOOK_PORT: String(getServerPort()),
            }
          : {}),
        ...(launchEnv ?? {}),
      };
      const terminalEnv = buildTerminalEnv(
        process.env,
        Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
      );
      if (shellKind === 'wsl') {
        appendWslenv(terminalEnv, [
          { name: 'TESSERA_ENV' },
          { name: 'TESSERA_CLI_COMMAND' },
          { name: 'TESSERA_PROJECT_ID' },
          { name: 'TESSERA_WORKTREE_ID' },
          { name: 'TESSERA_PANE_TOKEN' },
          { name: 'TESSERA_SESSION_ID' },
          { name: 'TESSERA_HOOK_PORT' },
          { name: 'TESSERA_OPENCODE_RESUME_ID' },
          // '/'로 시작하면 이미 게스트 POSIX 경로(codex-overlay-wsl.ts) — /p 변환을
          // 붙이면 오히려 망가진다. Windows 경로일 때만 /p (orca endpointFlag 미러).
          { name: 'CODEX_HOME', path: !terminalEnv.CODEX_HOME?.startsWith('/') },
          // profile의 CODEX_HOME export를 login 셸 -c 본문에서 되돌리기 위한 원본
          // (terminal-resolver의 재단언 스니펫이 소비).
          { name: 'TESSERA_CODEX_HOME', path: !terminalEnv.TESSERA_CODEX_HOME?.startsWith('/') },
          { name: 'OPENCODE_CONFIG_DIR', path: !terminalEnv.OPENCODE_CONFIG_DIR?.startsWith('/') },
          { name: 'TESSERA_OPENCODE_CONFIG_DIR', path: !terminalEnv.TESSERA_OPENCODE_CONFIG_DIR?.startsWith('/') },
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
      const spawnPtyProcess = (windowsPtyOptions: { useConptyDll?: boolean }) =>
        ptyFactory.spawn(shell.command, shell.args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: shell.cwd,
          env: terminalEnv,
          ...(getRuntimePlatform() === 'win32' ? windowsPtyOptions : {}),
        });
      try {
        // node-pty's bundled ConPTY (conpty.dll + OpenConsole, shipped in
        // prebuilds and asar-unpacked) has the modern wrap-marker behavior
        // xterm expects; the OS ConPTY on older Windows builds corrupts
        // full-width (CJK) TUI rows in scrollback and delta-repaints against
        // a grid the client may not have converged on yet. The previous
        // `useConpty: false` was a no-op — node-pty 1.2 removed winpty and
        // ignores that flag entirely, so Windows was silently running on the
        // legacy system ConPTY.
        terminalProcess = spawnPtyProcess({ useConptyDll: true });
      } catch (error) {
        if (getRuntimePlatform() !== 'win32') throw error;
        logger.warn(
          { error, terminalId: options.terminalId },
          'Bundled ConPTY spawn failed; retrying with the system ConPTY',
        );
        terminalProcess = spawnPtyProcess({});
      }
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
        runtimeStateAt: Date.now(),
        ended: false,
        cwd: shell.displayCwd ?? shell.cwd,
        shell: shell.command,
        appearanceChangePolicy: options.appearanceChangePolicy ?? 'live',
        resizeScrollbackPolicy: options.resizeScrollbackPolicy ?? 'native',
        canRestartForAppearance: options.canRestartForAppearance,
        appearanceRestartIntent: options.appearanceRestartIntent,
        appearanceRestartPending: false,
        process: processHandle,
        deviceQueryController: createTerminalDeviceQueryController(),
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
        restoresProviderSession: options.launchSpec?.restoresProviderSession,
        semanticPromptSubmissions: new Map(),
        acceptedSemanticPrompts: new Map(),
        disposeSessionObservers: options.launchObserverDisposer
          ? [options.launchObserverDisposer]
          : [],
        detectConversationReset: options.detectConversationReset,
        conversationResetHandledProviderSessionIds: new Set(),
        retiredProviderSessionIds: new Set(),
        backgroundProviderSessionIds: new Set(),
        reboundFromSessionIds: new Set(),
        previewOwnerToken: options.previewOwnerToken,
        onRuntimeExit: options.onRuntimeExit,
        pendingSessionSnapshots: new Set(),
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

      const emitOutput = (data: string) => {
        if (data.length === 0) return;
        // replay 버퍼: 원본 청크 순서/내용 그대로 즉시 누적 — coalescing과 독립.
        this.appendBufferedOutput(runtime, data);
        runtime.model.write(data);
        this.scheduleConversationResetScan(runtime);

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

      // CPR/DSR/DA는 여기서 소비한다 — 브라우저 xterm까지 왕복시키면 응답이 늦어
      // tty ECHO에 `^[[1;1R`로 찍힌다(codex는 기동 즉시 CSI 6n을 보낸다).
      // resize 트랜잭션 뒤에 두는 이유: 트랜잭션은 원본 청크 경계로 분할 ED3를
      // 재조립하므로, 그 앞에서 조각을 붙잡으면 경계 신호가 사라진다.
      const deliverOutput = (raw: string) => {
        if (raw.length === 0) return;
        // 세그먼트 순서대로 처리해야 커서 보고가 질의 시점의 위치를 답한다.
        for (const segment of runtime.deviceQueryController.consumeOutput(raw)) {
          emitOutput(segment.output);
          if (segment.query) this.answerDeviceQueries(runtime, segment.query);
        }
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
        // 트랜잭션을 다시 태우면 같은 조각이 컨트롤러에 재보관되어 유실되므로
        // 하위로 직접 흘린다.
        emitOutput(runtime.deviceQueryController.drain());
        clearPrefillTimers();
        this.finalizeRuntimeExit(runtime, key, event);
      });

      this.startSessionObserver(runtime);

      return runtime;
    } catch (error) {
      const runtimeSpawned = terminalProcess !== null;
      try {
        terminalProcess?.kill();
      } catch {
        // Spawn may have failed after allocating a partial native handle.
      }
      model?.dispose();
      if (this.terminals.get(key)?.process === terminalProcess) {
        this.terminals.delete(key);
      }
      this.disposeUnspawnedLaunch(options);
      throw new TerminalRuntimeStartError(
        error instanceof Error ? error.message : 'Failed to start terminal runtime.',
        runtimeSpawned,
        { cause: error },
      );
    }
  }

  private disposeUnspawnedLaunch(
    options: Omit<TerminalCreateOptions, 'connectionId' | 'surfaceId'>,
  ): void {
    if (options.sessionId) {
      this.clearTerminalReservation(options.userId, options.sessionId, options.terminalId);
    }
    if (options.launchSpec?.handoffSessionId) {
      releaseTerminalHandoffByTerminal(options.userId, options.terminalId);
    }
    options.launchObserverDisposer?.();
    if (options.paneToken) revokePaneToken(options.paneToken);
    cleanupCodexOverlayForTerminal(options.terminalId);
    cleanupCodexOverlayInWsl(options.terminalId);
  }

  private disposeSupersededLaunch(
    options: Omit<TerminalCreateOptions, 'connectionId' | 'surfaceId'>,
  ): void {
    options.launchObserverDisposer?.();
    if (options.paneToken) revokePaneToken(options.paneToken);
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
    this.sendStarted(runtime, subscriber, reattached);
    // Seed the surface with the grid the PTY is actually on. Its reconcile loop
    // verifies against this echo, and a pane that already agrees would otherwise
    // have nothing to verify against — no resize means no echo — and would spin
    // out its whole frame budget before giving up on an answer that was never
    // coming. This subscriber just took the viewport, so the echo is accepted.
    this.sendGrid(runtime, subscriber.connectionId, subscriber.surfaceId, true);
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
        alternateScreen: snapshot.alternateScreen,
        ...(snapshot.scrollbackAnsi !== undefined && {
          scrollbackAnsi: snapshot.scrollbackAnsi,
        }),
        ...(snapshot.pendingEscapeTailAnsi && {
          pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi,
        }),
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
        // Raw replay was produced at the live PTY's current grid, not at the
        // destination panel's requested dimensions.
        cols: runtime.cols,
        rows: runtime.rows,
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

  /**
   * Codex/OpenCode do not announce a conversation reset — they mint the next
   * session id only when the next prompt is submitted. What they do repaint,
   * immediately and however the command was issued, is the screen, so the
   * provider adapter reads that instead. Scans are throttled and only run while
   * a provider session is actually bound to this PTY.
   */
  private scheduleConversationResetScan(runtime: TerminalRuntime): void {
    if (!runtime.detectConversationReset || runtime.conversationResetScanTimer) return;
    runtime.conversationResetScanTimer = setTimeout(() => {
      runtime.conversationResetScanTimer = undefined;
      this.scanForConversationReset(runtime);
    }, CONVERSATION_RESET_SCAN_MS);
    runtime.conversationResetScanTimer.unref?.();
  }

  private scanForConversationReset(runtime: TerminalRuntime): void {
    const providerSessionId = runtime.providerSessionId;
    if (
      runtime.ended
      || !runtime.sessionId
      || !providerSessionId
      || !runtime.detectConversationReset
      || runtime.conversationResetHandledProviderSessionIds.has(providerSessionId)
    ) return;

    let reset = false;
    try {
      reset = runtime.detectConversationReset({
        visibleText: runtime.model.readVisibleText(),
        currentProviderSessionId: providerSessionId,
      });
    } catch (error) {
      logger.debug({ error, terminalId: runtime.terminalId },
        'Conversation reset detection skipped');
      return;
    }
    if (!reset) return;

    runtime.conversationResetHandledProviderSessionIds.add(providerSessionId);
    this.managerOptions.onTerminalConversationReset?.({
      terminalId: runtime.terminalId,
      userId: runtime.userId,
    });
  }

  /** Detaches the runtime from its provider identity without retiring it, so a
   *  reset that never happened can hand the same identity straight back. */
  clearProviderSessionIdentity(terminalId: string, userId: string): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended) return;
    runtime.providerSessionId = undefined;
  }

  /**
   * Writes the reply for a query consumed from the PTY output. It waits for the
   * model to finish parsing the output that preceded the query, so a cursor
   * report describes the position the querying program actually left behind
   * rather than a mid-chunk guess. A model without those members (test stubs)
   * degrades to the home position, which is what a fresh grid would report.
   */
  private answerDeviceQueries(runtime: TerminalRuntime, query: TerminalDeviceQueryKind): void {
    const settled = runtime.model.whenSettled?.() ?? Promise.resolve();
    void settled.then(() => {
      if (runtime.ended) return;
      const cursor = runtime.model.cursorPosition?.() ?? { row: 1, column: 1 };
      try {
        runtime.process.write(formatTerminalDeviceQueryReply(query, cursor));
      } catch {
        // The PTY can exit between emitting the query and receiving its reply.
      }
    });
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

  /** Submit one semantic follow-up without depending on an attached terminal surface. */
  async submitSessionPrompt(
    sessionId: string,
    userId: string,
    text: string,
  ): Promise<TerminalSessionSnapshot> {
    return this.submitSemanticSessionPrompt(sessionId, userId, text, true);
  }

  /** ChatView may be the first input after a restored TUI, before a lifecycle hook exists. */
  async submitSessionChatPrompt(
    sessionId: string,
    userId: string,
    text: string,
    submissionId: string,
  ): Promise<TerminalSessionSnapshot> {
    const runtime = this.requireLiveSessionRuntime(sessionId, userId);
    const accepted = runtime.acceptedSemanticPrompts.get(submissionId);
    if (accepted) {
      if (accepted.sessionId !== sessionId || accepted.text !== text) {
        throw new TerminalSessionInputError('A Session prompt id was reused with different input.');
      }
      return accepted.snapshot;
    }
    const pending = runtime.semanticPromptSubmissions.get(submissionId);
    if (pending) {
      if (pending.sessionId !== sessionId || pending.text !== text) {
        throw new TerminalSessionInputError('A Session prompt id was reused with different input.');
      }
      return pending.promise;
    }

    const promise = this.submitSemanticSessionPrompt(sessionId, userId, text, false);
    runtime.semanticPromptSubmissions.set(submissionId, { sessionId, text, promise });
    try {
      const snapshot = await promise;
      runtime.acceptedSemanticPrompts.set(submissionId, { sessionId, text, snapshot });
      while (runtime.acceptedSemanticPrompts.size > 32) {
        const oldest = runtime.acceptedSemanticPrompts.keys().next().value;
        if (typeof oldest !== 'string') break;
        runtime.acceptedSemanticPrompts.delete(oldest);
      }
      return snapshot;
    } finally {
      runtime.semanticPromptSubmissions.delete(submissionId);
    }
  }

  private async submitSemanticSessionPrompt(
    sessionId: string,
    userId: string,
    text: string,
    requireObservedState: boolean,
  ): Promise<TerminalSessionSnapshot> {
    const body = normalizeSemanticPrompt(text);
    if (!body.trim()) {
      throw new TerminalSessionInputError('The Session prompt must not be empty.');
    }
    const runtime = this.requireLiveSessionRuntime(sessionId, userId);
    if (
      runtime.prefillPending
      || (!runtime.lastSessionState && (requireObservedState || !runtime.restoresProviderSession))
    ) {
      throw new TerminalSessionInputError('The Session provider TUI is not ready for input.');
    }
    if (runtime.semanticPromptPending) {
      throw new TerminalSessionInputError('A Session prompt is already being submitted.');
    }

    runtime.resizeOutputTransaction?.settle();
    runtime.semanticPromptPending = true;
    try {
      runtime.process.write(bracketSemanticPrompt(body));
      const delayMs = this.managerOptions.semanticPromptSubmitDelayMs ?? 500;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
      if (
        runtime.ended
        || runtime.closing
        || this.getOwnedTerminal(runtime.terminalId, userId) !== runtime
        || runtime.sessionId !== sessionId
        || this.sessionBindings.get(this.getSessionKey(userId, sessionId)) !== runtime.terminalId
      ) {
        throw new TerminalSessionRuntimeNotRunningError(sessionId);
      }
      runtime.process.write('\r');
    } catch (error) {
      if (error instanceof TerminalSessionRuntimeNotRunningError) throw error;
      throw new TerminalSessionInputError('The Session provider TUI did not accept input.');
    } finally {
      runtime.semanticPromptPending = false;
    }

    // Enter is the irreversible acceptance boundary. Nothing below may turn a
    // successful submit into a rejection that encourages a duplicate retry.
    const stateAt = Date.now();
    const message: TerminalSessionStateMessage = {
      type: 'session_state',
      sessionId,
      terminalId: runtime.terminalId,
      status: 'running',
      hookEvent: 'ControlPromptSubmit',
      stateAt,
      interruptInputPolicy: runtime.interruptInputPolicy,
    };
    runtime.lastSessionState = message;
    runtime.runtimeStateAt = stateAt;
    this.notifySessionWaiters(runtime, message);
    try {
      this.managerOptions.onSessionStateChange?.({ message, userId });
    } catch (error) {
      logger.warn({ error, sessionId }, 'Session prompt lifecycle callback failed after acceptance');
    }

    let visibleText = '';
    let alternateScreen = false;
    try {
      visibleText = runtime.model.readVisibleText();
      alternateScreen = runtime.model.isAlternateScreen?.() ?? false;
    } catch (error) {
      logger.warn({ error, sessionId }, 'Session prompt snapshot read failed after acceptance');
    }
    return this.buildSessionSnapshot(runtime, {
      visibleText,
      cols: runtime.cols,
      rows: runtime.rows,
      alternateScreen,
      outputSequence: runtime.sequence,
      runtimeState: 'running',
      stateAt,
      lifecyclePreview: message.preview,
    });
  }

  /** Send only the public, closed set of named control keys to one live Session runtime. */
  async sendSessionKeys(
    sessionId: string,
    userId: string,
    keys: TerminalNamedKey[],
  ): Promise<TerminalSessionSnapshot> {
    if (keys.length === 0 || !keys.every(isTerminalNamedKey)) {
      throw new TerminalSessionInputError('At least one supported Session key is required.');
    }
    const runtime = this.requireLiveSessionRuntime(sessionId, userId);
    runtime.resizeOutputTransaction?.settle();
    for (const key of keys) {
      const data = terminalNamedKeySequence(key);
      runtime.process.write(data);
      this.observeAgentInterruptInput(runtime, data);
    }
    return this.trackSessionSnapshot(runtime);
  }

  /** Stop one exact live Session runtime and resolve only after its exit is observable. */
  async stopSessionRuntime(
    sessionId: string,
    userId: string,
  ): Promise<TerminalSessionSnapshot> {
    const runtime = this.requireLiveSessionRuntime(sessionId, userId);
    const sessionKey = this.getSessionKey(userId, sessionId);
    this.blockedSessions.add(sessionKey);
    try {
      const exited = new Promise<TerminalSessionSnapshot>((resolve) => {
        const waiter: TerminalSessionWaiter = { condition: 'runtime-exit', resolve };
        const waiters = this.sessionWaiters.get(sessionKey) ?? new Set<TerminalSessionWaiter>();
        waiters.add(waiter);
        this.sessionWaiters.set(sessionKey, waiters);
      });
      this.closeRuntime(runtime, true);
      return await exited;
    } finally {
      this.blockedSessions.delete(sessionKey);
    }
  }

  /** 살아있는 소유 runtime의 상태만 수락한다. false = 죽었거나 미소유인 pane의
   *  늦은 hook curl — 캐시도 브로드캐스트도 하면 안 되는 유령 상태다. */
  recordSessionState(message: TerminalSessionStateMessage, userId: string): boolean {
    const runtime = this.getOwnedTerminal(message.terminalId, userId);
    if (!runtime || runtime.sessionId !== message.sessionId || runtime.ended) return false;
    message.interruptInputPolicy = runtime.interruptInputPolicy;
    // Codex can emit the interrupted tool's PostToolUse before the Escape
    // settle timer fires. Keep that timer alive; otherwise the stale running
    // hook cancels the only idle signal and leaves the UI spinning forever.
    if (
      message.status === 'running'
      && message.hookEvent !== 'UserPromptSubmit'
      && (
        runtime.interruptInferenceTimer !== undefined
        || (
          runtime.interruptInferredAt !== undefined
          && Date.now() - runtime.interruptInferredAt <= INTERRUPTED_LATE_RUNNING_SUPPRESSION_MS
        )
      )
    ) {
      return false;
    }
    this.clearInterruptInference(runtime);
    runtime.interruptInferredAt = undefined;
    runtime.lastSessionState = message;
    runtime.runtimeStateAt = message.stateAt ?? Date.now();
    this.notifySessionWaiters(runtime, message);
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

  /** Read a Session runtime without creating or attaching a terminal surface. */
  async readSessionSnapshot(sessionId: string, userId: string): Promise<TerminalSessionSnapshot> {
    const terminalId = this.sessionBindings.get(this.getSessionKey(userId, sessionId));
    const runtime = terminalId ? this.getOwnedTerminal(terminalId, userId) : null;
    if (!runtime || runtime.ended || runtime.sessionId !== sessionId) {
      const opening = this.openingSessionObservations.get(this.getSessionKey(userId, sessionId));
      if (opening) {
        return {
          ...exitedSessionSnapshot(),
          terminalId: opening.terminalId,
          runtimeState: 'starting',
          stateAt: opening.stateAt,
        };
      }
      return exitedSessionSnapshot();
    }
    return this.trackSessionSnapshot(runtime);
  }

  /** Wait for one provider/runtime condition without creating or consuming a surface. */
  waitForSessionState(
    sessionId: string,
    userId: string,
    condition: TerminalSessionWaitCondition,
    timeoutMs: number,
  ): Promise<TerminalSessionSnapshot> {
    const sessionKey = this.getSessionKey(userId, sessionId);
    return new Promise<TerminalSessionSnapshot>((resolve, reject) => {
      const waiter: TerminalSessionWaiter = { condition, resolve };
      waiter.timer = setTimeout(() => {
        this.removeSessionWaiter(sessionKey, waiter);
        reject(new TerminalSessionWaitTimeoutError(condition, timeoutMs));
      }, Math.max(0, timeoutMs));
      const waiters = this.sessionWaiters.get(sessionKey) ?? new Set<TerminalSessionWaiter>();
      waiters.add(waiter);
      this.sessionWaiters.set(sessionKey, waiters);

      // Subscribe first, then read. A transition in between is delivered by
      // notifySessionWaiters, while an earlier transition is seen by this read.
      void this.readSessionSnapshot(sessionId, userId).then((snapshot) => {
        this.settleSessionWaiter(sessionKey, waiter, snapshot);
      }).catch((error: unknown) => {
        if (!this.removeSessionWaiter(sessionKey, waiter)) return;
        if (waiter.timer) clearTimeout(waiter.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  resize(
    terminalId: string,
    userId: string,
    connectionId: string,
    surfaceId: string,
    cols: number,
    rows: number,
    claim = false,
    replayRefresh = false,
  ): void {
    const runtime = this.getOwnedTerminal(terminalId, userId);
    if (!runtime || runtime.ended) return;
    const subscriberKey = this.getSubscriberKey(connectionId, surfaceId);
    if (!runtime.subscribers.has(subscriberKey)) return;
    if (claim || runtime.viewportOwner === null) {
      runtime.viewportOwner = subscriberKey;
    }
    if (runtime.viewportOwner !== subscriberKey) {
      this.sendGrid(runtime, connectionId, surfaceId, false);
      return;
    }
    this.resizeRuntime(runtime, cols, rows, replayRefresh);
    this.sendGrid(runtime, connectionId, surfaceId, true);
  }

  /**
   * Echo the PTY's applied grid so the surface can verify what it sent landed.
   * Sent on every resize, accepted or dropped: a surface that never hears back
   * cannot tell "the PTY took 178x57" from "another surface owns the viewport
   * and my request went nowhere", and would keep rendering against a grid the
   * TUI is not drawing at.
   */
  private sendGrid(
    runtime: TerminalRuntime,
    connectionId: string,
    surfaceId: string,
    accepted: boolean,
  ): void {
    this.sendToConnection(connectionId, {
      type: 'terminal_grid',
      terminalId: runtime.terminalId,
      surfaceId,
      cols: runtime.cols,
      rows: runtime.rows,
      accepted,
    });
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

  private closeRuntime(runtime: TerminalRuntime, keepProcessAlive = false): void {
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
        keepProcessAlive,
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

  private scheduleCloseWatchdog(
    runtime: TerminalRuntime,
    key: string,
    delayMs: number,
    keepProcessAlive: boolean,
  ): void {
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
        keepProcessAlive,
      );
    }, Math.max(0, delayMs));
    // An explicitly awaited Session stop must reach an observable exit even in
    // a short-lived command/test process. Fire-and-forget surface closes keep
    // the historical unref behavior so a stuck PTY cannot own server shutdown.
    if (!keepProcessAlive) runtime.closeWatchdog.unref?.();
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
    const exitStateAt = Date.now();
    const hasExitWaiters = runtime.sessionId
      ? [...(this.sessionWaiters.get(this.getSessionKey(runtime.userId, runtime.sessionId)) ?? [])]
        .some((waiter) => waiter.condition === 'runtime-exit')
      : false;
    if (isCurrent) {
      this.terminals.delete(key);
      this.clearSessionBinding(runtime);
      revokePaneTokensForTerminal(runtime.terminalId);
      cleanupCodexOverlayForTerminal(runtime.terminalId);
      cleanupCodexOverlayInWsl(runtime.terminalId);
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
    if (hasExitWaiters || runtime.pendingSessionSnapshots.size > 0) {
      void Promise.allSettled([...runtime.pendingSessionSnapshots]).then(async () => {
        if (hasExitWaiters) {
          await resolveSnapshotWithTimeout(
            runtime.model,
            this.managerOptions.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
          ).catch((error) => {
            logger.warn(
              { error, terminalId: runtime.terminalId },
              'Runtime-exit waiter used the last parsed screen',
            );
          });
          this.notifySessionExitWaiters(runtime, exitStateAt);
        }
        runtime.model.dispose();
      });
    } else {
      runtime.model.dispose();
    }
    this.sendExit(runtime, event);
    if (runtime.onRuntimeExit) {
      // The buffer is what a surface attaching now would have been replayed, so
      // it is also what there is to say about a run nobody watched.
      const output = runtime.outputBuffer.join('');
      try {
        runtime.onRuntimeExit(event, output);
      } catch (error) {
        logger.error({ error, terminalId: runtime.terminalId }, 'Terminal exit observer failed');
      }
    }
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
    if (
      !runtime
      || runtime.ended
      || runtime.semanticPromptPending
      || runtime.sessionId !== sourceSessionId
    ) return false;

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
    return this.getLaunchRuntimeState(terminalId, userId, sessionId) !== 'unowned';
  }

  getLaunchRuntimeState(
    terminalId: string,
    userId: string,
    sessionId?: string | null,
  ): TerminalLaunchRuntimeState {
    const key = this.getKey(userId, terminalId);
    const runtime = this.terminals.get(key);
    if (runtime && (!sessionId || runtime.sessionId === sessionId)) return 'spawned';
    return this.openingTerminals.has(this.getOpeningKey(userId, terminalId, sessionId))
      ? 'opening'
      : 'unowned';
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

  private recordOpeningSession(
    options: Pick<TerminalCreateOptions, 'sessionId' | 'userId' | 'terminalId'>,
  ): void {
    if (!options.sessionId) return;
    const sessionKey = this.getSessionKey(options.userId, options.sessionId);
    if (!this.openingSessionObservations.has(sessionKey)) {
      this.openingSessionObservations.set(sessionKey, {
        terminalId: options.terminalId,
        stateAt: Date.now(),
      });
    }
  }

  private clearOpeningSession(
    options: Pick<TerminalCreateOptions, 'sessionId' | 'userId' | 'terminalId'>,
  ): void {
    if (!options.sessionId) return;
    const sessionKey = this.getSessionKey(options.userId, options.sessionId);
    if (this.openingSessionObservations.get(sessionKey)?.terminalId === options.terminalId) {
      this.openingSessionObservations.delete(sessionKey);
    }
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

    if (options.agentEnvironment) {
      return options.agentEnvironment === 'wsl' ? 'wsl' : options.shellKind;
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
      interruptInputPolicy: runtime.interruptInputPolicy,
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

  private resizeRuntime(
    runtime: TerminalRuntime,
    cols: number,
    rows: number,
    forceRefresh = false,
  ): void {
    const normalizedCols = normalizeTerminalDimension(cols, 80, MAX_TERMINAL_COLS);
    const normalizedRows = normalizeTerminalDimension(rows, 24, MAX_TERMINAL_ROWS);
    const dimensionsChanged = runtime.cols !== normalizedCols || runtime.rows !== normalizedRows;
    if (!dimensionsChanged && !forceRefresh) return;
    if (runtime.resizeScrollbackPolicy === 'preserve-on-ed3') {
      runtime.resizeOutputTransaction?.begin();
    }
    runtime.process.resize(normalizedCols, normalizedRows);
    if (dimensionsChanged) {
      runtime.model.resize(normalizedCols, normalizedRows);
      runtime.cols = normalizedCols;
      runtime.rows = normalizedRows;
    }

    if (forceRefresh && getRuntimePlatform() !== 'win32') {
      // POSIX node-pty only emits SIGWINCH when dimensions change. Snapshot
      // replay also needs a repaint at the same grid, so mirror Orca's
      // explicit post-replay signal. ConPTY gets the same-size native resize
      // above; node-pty does not support signals on Windows.
      try {
        runtime.process.kill('SIGWINCH');
      } catch {
        // The process may have exited between replay and refresh.
      }
    }
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
      interruptInputPolicy: runtime.interruptInputPolicy,
    };
    runtime.interruptInferredAt = stateAt;
    runtime.lastSessionState = message;
    runtime.runtimeStateAt = stateAt;
    this.notifySessionWaiters(runtime, message);
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

  private async captureSessionSnapshot(
    runtime: TerminalRuntime,
    observedState: TerminalSessionStateMessage | undefined = runtime.lastSessionState,
  ): Promise<TerminalSessionSnapshot> {
    this.flushPendingOutput(runtime);
    const outputSequence = runtime.sequence;
    let cols = runtime.cols;
    let rows = runtime.rows;
    let alternateScreen = false;
    let visibleText: string | undefined;
    try {
      const modelSnapshot = await resolveSnapshotWithTimeout(
        runtime.model,
        this.managerOptions.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
      );
      cols = modelSnapshot.cols;
      rows = modelSnapshot.rows;
      alternateScreen = modelSnapshot.alternateScreen;
      visibleText = modelSnapshot.visibleText;
    } catch (error) {
      logger.warn(
        { error, terminalId: runtime.terminalId },
        'Server-side Session snapshot used the last parsed screen',
      );
    }

    return this.buildSessionSnapshot(runtime, {
      visibleText: visibleText ?? runtime.model.readVisibleText(),
      cols,
      rows,
      alternateScreen,
      outputSequence,
      runtimeState: normalizeSessionRuntimeState(observedState),
      stateAt: observedState?.stateAt ?? runtime.runtimeStateAt,
      lifecyclePreview: observedState?.preview,
    });
  }

  private trackSessionSnapshot(
    runtime: TerminalRuntime,
    observedState?: TerminalSessionStateMessage,
  ): Promise<TerminalSessionSnapshot> {
    const snapshot = this.captureSessionSnapshot(runtime, observedState);
    const completion = snapshot.then(() => undefined, () => undefined);
    runtime.pendingSessionSnapshots.add(completion);
    void completion.finally(() => runtime.pendingSessionSnapshots.delete(completion));
    return snapshot;
  }

  private notifySessionWaiters(
    runtime: TerminalRuntime,
    observedState: TerminalSessionStateMessage,
  ): void {
    if (!runtime.sessionId) return;
    const sessionKey = this.getSessionKey(runtime.userId, runtime.sessionId);
    const waiters = this.sessionWaiters.get(sessionKey);
    const runtimeState = normalizeSessionRuntimeState(observedState);
    if (!waiters || ![...waiters].some((waiter) => waitConditionMatches(
      waiter.condition,
      runtimeState,
    ))) return;

    void this.trackSessionSnapshot(runtime, observedState).then((snapshot) => {
      for (const waiter of [...(this.sessionWaiters.get(sessionKey) ?? [])]) {
        this.settleSessionWaiter(sessionKey, waiter, snapshot);
      }
    }).catch((error) => {
      logger.warn({ error, sessionId: runtime.sessionId }, 'Session waiter snapshot failed');
    });
  }

  private notifySessionExitWaiters(runtime: TerminalRuntime, stateAt: number): void {
    if (!runtime.sessionId) return;
    const sessionKey = this.getSessionKey(runtime.userId, runtime.sessionId);
    const waiters = this.sessionWaiters.get(sessionKey);
    if (!waiters || ![...waiters].some((waiter) => waiter.condition === 'runtime-exit')) return;
    const snapshot = this.buildSessionSnapshot(runtime, {
      visibleText: runtime.model.readVisibleText(),
      cols: runtime.cols,
      rows: runtime.rows,
      alternateScreen: runtime.model.isAlternateScreen?.() ?? false,
      outputSequence: runtime.sequence,
      runtimeState: 'exited',
      stateAt,
      lifecyclePreview: runtime.lastSessionState?.preview,
    });
    for (const waiter of [...waiters]) {
      this.settleSessionWaiter(sessionKey, waiter, snapshot);
    }
  }

  private notifySessionWithoutRuntime(
    sessionId: string,
    userId: string,
    terminalId: string,
  ): void {
    const sessionKey = this.getSessionKey(userId, sessionId);
    const waiters = this.sessionWaiters.get(sessionKey);
    if (!waiters) return;
    const snapshot: TerminalSessionSnapshot = {
      ...exitedSessionSnapshot(),
      terminalId,
      stateAt: Date.now(),
    };
    for (const waiter of [...waiters]) {
      this.settleSessionWaiter(sessionKey, waiter, snapshot);
    }
  }

  private settleSessionWaiter(
    sessionKey: string,
    waiter: TerminalSessionWaiter,
    snapshot: TerminalSessionSnapshot,
  ): void {
    if (!waitConditionMatches(waiter.condition, snapshot.runtimeState)) return;
    if (!this.removeSessionWaiter(sessionKey, waiter)) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(snapshot);
  }

  private removeSessionWaiter(sessionKey: string, waiter: TerminalSessionWaiter): boolean {
    const waiters = this.sessionWaiters.get(sessionKey);
    if (!waiters?.delete(waiter)) return false;
    if (waiters.size === 0) this.sessionWaiters.delete(sessionKey);
    return true;
  }

  private requireLiveSessionRuntime(sessionId: string, userId: string): TerminalRuntime {
    const terminalId = this.sessionBindings.get(this.getSessionKey(userId, sessionId));
    const runtime = terminalId ? this.getOwnedTerminal(terminalId, userId) : null;
    if (
      !runtime
      || runtime.ended
      || runtime.closing
      || runtime.sessionId !== sessionId
    ) {
      throw new TerminalSessionRuntimeNotRunningError(sessionId);
    }
    return runtime;
  }

  private buildSessionSnapshot(
    runtime: TerminalRuntime,
    values: {
      visibleText: string;
      cols: number;
      rows: number;
      alternateScreen: boolean;
      outputSequence: number;
      runtimeState: TerminalSessionRuntimeState;
      stateAt: number;
      lifecyclePreview?: string;
    },
  ): TerminalSessionSnapshot {
    const lifecyclePreview = sanitizeBoundedPlainText(
      values.lifecyclePreview ?? '',
      MAX_SESSION_LIFECYCLE_PREVIEW_CHARS,
    );
    return {
      screen: sanitizeBoundedPlainText(
        values.visibleText,
        MAX_SESSION_SCREEN_CHARS,
      ).trimEnd(),
      cols: values.cols,
      rows: values.rows,
      alternateScreen: values.alternateScreen,
      outputSequence: values.outputSequence,
      terminalId: runtime.terminalId,
      runtimeState: values.runtimeState,
      stateAt: values.stateAt,
      ...(lifecyclePreview ? { lifecyclePreview } : {}),
    };
  }
}

function normalizeSessionRuntimeState(
  state: TerminalSessionStateMessage | undefined,
): TerminalSessionRuntimeState {
  switch (state?.status) {
    case 'idle': return 'idle';
    case 'running': return 'running';
    case 'input_required': return 'input-required';
    case 'completed': return 'turn-complete';
    default: return 'starting';
  }
}

function exitedSessionSnapshot(): TerminalSessionSnapshot {
  return {
    screen: '',
    cols: null,
    rows: null,
    alternateScreen: false,
    outputSequence: 0,
    terminalId: null,
    runtimeState: 'exited',
    stateAt: null,
  };
}

function waitConditionMatches(
  condition: TerminalSessionWaitCondition,
  state: TerminalSessionRuntimeState,
): boolean {
  return condition === 'runtime-exit' ? state === 'exited' : condition === state;
}

function sanitizeBoundedPlainText(value: string, maxChars: number): string {
  const sanitized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  const characters = [...sanitized];
  return characters.length <= maxChars
    ? sanitized
    : characters.slice(characters.length - maxChars).join('');
}

export class TerminalSessionWaitTimeoutError extends Error {
  constructor(
    readonly condition: TerminalSessionWaitCondition,
    readonly timeoutMs: number,
  ) {
    super(`Session did not reach ${condition} within the requested timeout.`);
    this.name = 'TerminalSessionWaitTimeoutError';
  }
}

export class TerminalSessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalSessionInputError';
  }
}

export class TerminalSessionRuntimeNotRunningError extends Error {
  constructor(readonly sessionId: string) {
    super('The Session does not have a live PTY runtime.');
    this.name = 'TerminalSessionRuntimeNotRunningError';
  }
}

export class TerminalRuntimeStartError extends Error {
  constructor(
    message: string,
    readonly runtimeSpawned: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TerminalRuntimeStartError';
  }
}
