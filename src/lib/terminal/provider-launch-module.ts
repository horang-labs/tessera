import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import type { CliProvider } from '@/lib/cli/providers/types';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import * as dbSessions from '@/lib/db/sessions';
import { getTaskPreparation } from '@/lib/db/task-preparation';
import { getTerminalProviderSessionForTesseraSession } from '@/lib/db/terminal-provider-sessions';
import logger from '@/lib/logger';
import { waitForPreparationBeforeAgent } from '@/lib/projects/preparation-gate';
import { sessionHistory } from '@/lib/session-history';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import type { HookCommandStyle } from './hook-command';
import { buildClaudeHookSettingsJson } from './claude-hook-settings';
import { createClaudeSkillOverlay } from './claude-skill-overlay';
import {
  createClaudeSkillOverlayInWsl,
} from './claude-skill-overlay-wsl';
import { createCodexOverlay } from './codex-overlay';
import {
  createCodexOverlayInWsl,
} from './codex-overlay-wsl';
import { createOpenCodeOverlay } from './opencode-overlay';
import { createOpenCodeOverlayInWsl } from './opencode-overlay-wsl';
import { mintPaneToken, revokePaneToken } from './pane-token-registry';
import {
  buildProviderTerminalLaunch,
  TERMINAL_PROVIDER_COMMANDS,
} from './provider-launch';
import {
  resolveTerminalProviderSessionReference,
  type TerminalProviderSessionIdentity,
} from './provider-session-identity';
import { createTerminalProviderSessionObserver } from './provider-session-observer';
import { resolveSessionWorkspaceRoot } from '@/lib/session/session-workspace-root';
import {
  TerminalRuntimeStartError,
  type TerminalLaunchRuntimeState,
  type TerminalManager,
} from './terminal-manager';
import type { TerminalAppearance, TerminalCreateOptions, TerminalLaunchSpec } from './types';
import type {
  ControlCliBridgeContext,
  PreparedControlCliBridge,
} from '@/lib/control/cli-bridge';
import type { AgentEnvironment } from '@/lib/settings/types';

const MAX_INITIAL_PROMPT_BYTES = 16_384;
const DEFAULT_PREPARATION_TIMEOUT_MS = 10 * 60 * 1000;
const SAFE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ProviderLaunchErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_TERMINAL'
  | 'SESSION_PROVIDER_MISMATCH'
  | 'SESSION_WORKSPACE_UNAVAILABLE'
  | 'SESSION_RUNTIME_ALREADY_RUNNING'
  | 'SESSION_NOT_FRESH'
  | 'PROVIDER_NOT_SUPPORTED'
  | 'INITIAL_PROMPT_EMPTY'
  | 'INITIAL_PROMPT_TOO_LARGE'
  | 'PREPARATION_FAILED'
  | 'PREPARATION_TIMEOUT'
  | 'LAUNCH_FAILED';

export type ProviderLaunchRuntimeState = TerminalLaunchRuntimeState;

export class ProviderLaunchError extends Error {
  constructor(
    readonly code: ProviderLaunchErrorCode,
    message: string,
    readonly terminalId?: string,
    options?: ErrorOptions,
    readonly runtimeState: ProviderLaunchRuntimeState = 'unowned',
  ) {
    super(message, options);
    this.name = 'ProviderLaunchError';
  }

  get runtimeSpawned(): boolean {
    return this.runtimeState === 'spawned';
  }

  get runtimeOwned(): boolean {
    return this.runtimeState !== 'unowned';
  }
}

export interface ProviderLaunchSurfaceMetadata {
  connectionId: string;
  surfaceId: string;
  terminalId: string;
  previewOwnerToken?: string;
  cols?: number;
  rows?: number;
  appearance?: TerminalAppearance;
  /** Existing UI behavior: prepare text in the TUI without submitting it. */
  prefillInput?: string;
  /** Compatibility guard for the provider identity sent by older renderers. */
  expectedProviderId?: string;
  onAwaitingPreparation?: (terminalId: string) => void;
}

interface ProviderLaunchRequestBase {
  sessionId: string;
  userId: string;
  initialPrompt?: string;
  allowPreparationFailure?: boolean;
}

export type ProviderLaunchRequest = ProviderLaunchRequestBase & (
  | {
      mode: 'surface';
      surface: ProviderLaunchSurfaceMetadata;
    }
  | {
      mode: 'detached';
      surface?: never;
    }
);

export interface ProviderLaunchResult {
  terminalId: string;
  attachedToExistingRuntime: boolean;
}

export interface ProviderLaunchModule {
  supportsProvider(providerId: string): boolean;
  launch(request: ProviderLaunchRequest): Promise<ProviderLaunchResult>;
}

type ProviderLaunchTerminalAdapter = Pick<
  TerminalManager,
  | 'create'
  | 'startDetached'
  | 'reserveTerminalId'
  | 'releaseTerminalReservation'
  | 'getLaunchRuntimeState'
  | 'getSessionIdForTerminal'
>;

interface ProviderLaunchModuleOptions {
  terminalManager: ProviderLaunchTerminalAdapter;
  preparationTimeoutMs?: number;
  resolveAgentEnvironment?: (userId: string) => Promise<AgentEnvironment>;
  observeProviderSession?: (options: {
    pane: {
      terminalId: string;
      userId: string;
      sessionId: string;
      providerId: string;
    };
    identity: TerminalProviderSessionIdentity;
    activation: 'active' | 'background';
  }) => void;
  prepareControlCliBridge?: (
    context: ControlCliBridgeContext,
  ) => Promise<PreparedControlCliBridge>;
}

interface ProviderLaunchDecision {
  launchSpec: TerminalLaunchSpec;
  provider: CliProvider;
  providerId: string;
  providerState: string | null;
}

function providerLaunchError(
  code: ProviderLaunchErrorCode,
  message: string,
  terminalId?: string,
  cause?: unknown,
  runtimeState: ProviderLaunchRuntimeState = 'unowned',
): ProviderLaunchError {
  return new ProviderLaunchError(
    code,
    message,
    terminalId,
    cause === undefined ? undefined : { cause },
    runtimeState,
  );
}

export function isSupportedTerminalProvider(providerId: string): boolean {
  return Object.hasOwn(TERMINAL_PROVIDER_COMMANDS, providerId)
    && cliProviderRegistry.hasProvider(providerId);
}

function validateInitialPrompt(initialPrompt: string | undefined): void {
  if (initialPrompt === undefined) return;
  if (initialPrompt.trim().length === 0) {
    throw providerLaunchError(
      'INITIAL_PROMPT_EMPTY',
      'The initial prompt must contain non-whitespace text.',
    );
  }
  if (Buffer.byteLength(initialPrompt, 'utf8') > MAX_INITIAL_PROMPT_BYTES) {
    throw providerLaunchError(
      'INITIAL_PROMPT_TOO_LARGE',
      `The initial prompt exceeds ${MAX_INITIAL_PROMPT_BYTES.toLocaleString('en-US')} UTF-8 bytes.`,
    );
  }
}

function requireFreshConversationForPrompt(
  resume: boolean,
  initialPrompt: string | undefined,
  terminalId?: string,
): void {
  if (!resume || initialPrompt === undefined) return;
  throw providerLaunchError(
    'SESSION_NOT_FRESH',
    'An initial prompt is allowed only for a fresh provider conversation.',
    terminalId,
  );
}

function resolveRequestedTerminalId(request: ProviderLaunchRequest): string {
  const terminalId = request.mode === 'surface'
    ? request.surface.terminalId
    : `session-${request.sessionId}`;
  if (!SAFE_TERMINAL_ID.test(terminalId)) {
    throw providerLaunchError('LAUNCH_FAILED', 'The terminal identity is invalid.');
  }
  return terminalId;
}

function getPersistedProvider(request: ProviderLaunchRequest): {
  provider: CliProvider;
  providerId: string;
  providerState: string | null;
} {
  const session = dbSessions.getSession(request.sessionId);
  if (!session || session.deleted === 1) {
    throw providerLaunchError('SESSION_NOT_FOUND', 'Session does not exist.');
  }
  if (dbSessions.extractSessionKind(session.provider_state) !== 'terminal') {
    throw providerLaunchError(
      'SESSION_NOT_TERMINAL',
      'Terminal launch does not match the persisted session provider.',
    );
  }
  if (
    request.mode === 'surface'
    && request.surface.expectedProviderId
    && request.surface.expectedProviderId !== session.provider
  ) {
    throw providerLaunchError(
      'SESSION_PROVIDER_MISMATCH',
      'Terminal launch does not match the persisted session provider.',
    );
  }
  if (!isSupportedTerminalProvider(session.provider)) {
    throw providerLaunchError(
      'PROVIDER_NOT_SUPPORTED',
      `Terminal launch is not supported for provider '${session.provider}'.`,
    );
  }

  try {
    return {
      provider: cliProviderRegistry.getProvider(session.provider),
      providerId: session.provider,
      providerState: session.provider_state,
    };
  } catch (error) {
    throw providerLaunchError(
      'PROVIDER_NOT_SUPPORTED',
      `Terminal launch is not supported for provider '${session.provider}'.`,
      undefined,
      error,
    );
  }
}

async function buildLaunchDecision(
  request: ProviderLaunchRequest,
  persisted: ReturnType<typeof getPersistedProvider>,
  hookCommandStyle: HookCommandStyle,
  claudePluginDir?: string,
): Promise<ProviderLaunchDecision> {
  const { providerId, providerState } = persisted;

  if (providerId === 'claude-code') {
    const providerSession = resolveTerminalProviderSessionReference(
      request.sessionId,
      providerState,
    );
    const resume = providerSession.nativeFork
      || await sessionHistory.historyExists(request.sessionId);
    requireFreshConversationForPrompt(resume, request.initialPrompt);
    const built = buildProviderTerminalLaunch({
      providerId,
      sessionId: providerSession.providerSessionId,
      resume,
      providerSessionActivation: providerSession.activation
        ?? (providerSession.nativeFork ? 'background' : undefined),
      settingsJson: buildClaudeHookSettingsJson(hookCommandStyle),
      initialPrompt: request.initialPrompt,
      claudePluginDir,
    });
    return {
      provider: persisted.provider,
      providerId,
      providerState,
      launchSpec: {
        program: built.command,
        args: built.args,
        ...(request.mode === 'surface' && request.surface.prefillInput
          ? { prefillInput: request.surface.prefillInput }
          : {}),
      },
    };
  }

  if (providerId === 'codex') {
    const codexResumeId = dbSessions.extractCodexTerminalSessionId(providerState);
    requireFreshConversationForPrompt(Boolean(codexResumeId), request.initialPrompt);
    const built = buildProviderTerminalLaunch({
      providerId,
      sessionId: request.sessionId,
      resume: Boolean(codexResumeId),
      codexResumeId,
      initialPrompt: request.initialPrompt,
    });
    return {
      provider: persisted.provider,
      providerId,
      providerState,
      launchSpec: {
        program: built.command,
        args: built.args,
        ...(request.mode === 'surface' && request.surface.prefillInput
          ? { prefillInput: request.surface.prefillInput }
          : {}),
      },
    };
  }

  const opencodeResumeId = dbSessions.extractOpenCodeTerminalSessionId(providerState);
  requireFreshConversationForPrompt(Boolean(opencodeResumeId), request.initialPrompt);
  const built = buildProviderTerminalLaunch({
    providerId,
    sessionId: request.sessionId,
    resume: Boolean(opencodeResumeId),
    opencodeResumeId,
    initialPrompt: request.initialPrompt,
  });
  return {
    provider: persisted.provider,
    providerId,
    providerState,
    launchSpec: {
      program: built.command,
      args: built.args,
      ...(request.mode === 'surface' && request.surface.prefillInput
        ? { prefillInput: request.surface.prefillInput }
        : {}),
    },
  };
}

function createDisposerStack(): {
  add(disposer: () => void): void;
  dispose(): void;
  asDisposer(): (() => void) | undefined;
} {
  const disposers: Array<() => void> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const disposer of disposers.reverse()) {
      try {
        disposer();
      } catch (error) {
        logger.debug({ error }, 'Provider launch resource cleanup skipped');
      }
    }
  };
  return {
    add: (disposer) => disposers.push(disposer),
    dispose,
    asDisposer: () => (disposers.length > 0 ? dispose : undefined),
  };
}

export function createProviderLaunchModule(
  options: ProviderLaunchModuleOptions,
): ProviderLaunchModule {
  const manager = options.terminalManager;
  const activeLaunches = new Map<string, Promise<ProviderLaunchResult>>();

  const launchOnce = async (
    request: ProviderLaunchRequest,
    persisted: ReturnType<typeof getPersistedProvider>,
    requestedTerminalId: string,
  ): Promise<ProviderLaunchResult> => {
      const terminalId = manager.reserveTerminalId(
        request.userId,
        requestedTerminalId,
        request.sessionId,
      );
      const resourceDisposers = createDisposerStack();
      let transferredToTerminalManager = false;
      let paneToken: string | undefined;
      const cleanupLaunchOwnedResources = () => {
        resourceDisposers.dispose();
        if (paneToken) revokePaneToken(paneToken);
      };
      const cleanupBeforeTransfer = () => {
        manager.releaseTerminalReservation(request.userId, request.sessionId, terminalId);
        cleanupLaunchOwnedResources();
      };

      try {
        const existingRuntimeState = manager.getLaunchRuntimeState(
          terminalId,
          request.userId,
          request.sessionId,
        );
        if (existingRuntimeState !== 'unowned' && request.mode === 'detached') {
          throw providerLaunchError(
            'SESSION_RUNTIME_ALREADY_RUNNING',
            'The Session already has a live PTY runtime.',
            terminalId,
            undefined,
            existingRuntimeState,
          );
        }

        if (existingRuntimeState !== 'unowned' && request.mode === 'surface') {
          requireFreshConversationForPrompt(true, request.initialPrompt, terminalId);
          transferredToTerminalManager = true;
          await manager.create({
            userId: request.userId,
            connectionId: request.surface.connectionId,
            surfaceId: request.surface.surfaceId,
            previewOwnerToken: request.surface.previewOwnerToken,
            terminalId,
            cwd: null,
            sessionId: request.sessionId,
            cols: request.surface.cols,
            rows: request.surface.rows,
            appearance: request.surface.appearance,
          });
          return { terminalId, attachedToExistingRuntime: true };
        }

        const workDir = resolveSessionWorkspaceRoot(request.sessionId);
        if (!workDir) {
          throw providerLaunchError(
            'SESSION_WORKSPACE_UNAVAILABLE',
            'The session workspace is unavailable.',
            terminalId,
          );
        }

        const preparation = await waitForPreparationBeforeAgent({
          workDir,
          timeoutMs: options.preparationTimeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS,
          onWaitStarted: request.mode === 'surface'
            ? () => request.surface.onAwaitingPreparation?.(terminalId)
            : undefined,
        });
        if (
          request.mode === 'detached'
          && preparation.waited
          && preparation.result === 'timedOut'
        ) {
          throw providerLaunchError(
            'PREPARATION_TIMEOUT',
            'Worktree preparation did not finish before the timeout.',
            terminalId,
          );
        }
        const worktreeContext = dbSessions.getSessionWorktreeContext(request.sessionId);
        const storedPreparation = worktreeContext?.taskId
          ? getTaskPreparation(worktreeContext.taskId)
          : null;
        if (
          request.mode === 'detached'
          && !request.allowPreparationFailure
          && storedPreparation?.status === 'failed'
          && storedPreparation.phase === 'before'
        ) {
          throw providerLaunchError(
            'PREPARATION_FAILED',
            'Worktree preparation failed before an agent could start.',
            terminalId,
          );
        }

        const agentEnvironment = await (
          options.resolveAgentEnvironment?.(request.userId)
          ?? getAgentEnvironment(request.userId)
        );
        const callerContext = dbSessions.getManagedSessionCallerContext(request.sessionId);
        if (!callerContext) {
          throw providerLaunchError(
            'SESSION_NOT_FOUND',
            'Session does not exist.',
            terminalId,
          );
        }
        const wslTerminalRuntime = getRuntimePlatform() === 'win32'
          && agentEnvironment === 'wsl';
        const hookCommandStyle: HookCommandStyle = getRuntimePlatform() === 'win32'
          && !wslTerminalRuntime
          ? 'windows-cmd'
          : 'posix';
        let claudePluginDir: string | undefined;
        if (persisted.providerId === 'claude-code') {
          if (wslTerminalRuntime) {
            claudePluginDir = '__tessera_claude_plugin_pending__';
          } else {
            const overlay = createClaudeSkillOverlay(terminalId);
            resourceDisposers.add(overlay.dispose);
            claudePluginDir = overlay.pluginDir;
          }
        }
        const decision = await buildLaunchDecision(
          request,
          persisted,
          hookCommandStyle,
          claudePluginDir,
        );
        decision.launchSpec.cwd = workDir;

        let launchEnv: Record<string, string | undefined> | undefined;
        let prepareLaunch: (() => Promise<void>) | undefined;
        let launchEnvFactory:
          (() => Promise<Record<string, string | undefined> | undefined>) | undefined;
        const claudePluginFlagIndex = decision.launchSpec.args?.indexOf('--plugin-dir') ?? -1;
        if (
          decision.providerId === 'claude-code'
          && wslTerminalRuntime
          && claudePluginFlagIndex >= 0
          && decision.launchSpec.args
        ) {
          const claudeArgs = decision.launchSpec.args;
          prepareLaunch = async () => {
            try {
              const overlay = await createClaudeSkillOverlayInWsl(terminalId);
              claudeArgs[claudePluginFlagIndex + 1] = overlay.pluginDir;
              resourceDisposers.add(() => {
                void overlay.dispose().catch((error) => {
                  logger.debug({ error }, 'Claude WSL skill overlay cleanup skipped');
                });
              });
            } catch (error) {
              logger.error({ error, terminalId }, 'Failed to prepare the Claude WSL skill overlay');
              throw new Error(
                `Failed to prepare the Claude WSL skill overlay: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          };
        } else if (decision.providerId === 'codex') {
          launchEnvFactory = async () => {
            try {
              const overlayHome = wslTerminalRuntime
                ? await createCodexOverlayInWsl(terminalId, hookCommandStyle)
                : createCodexOverlay(terminalId, hookCommandStyle);
              return { CODEX_HOME: overlayHome, TESSERA_CODEX_HOME: overlayHome };
            } catch (error) {
              logger.error({ error, terminalId }, 'Failed to prepare the Codex overlay');
              throw new Error(
                `Failed to prepare the Codex overlay: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          };
        } else if (decision.providerId === 'opencode') {
          const opencodeResumeId = dbSessions.extractOpenCodeTerminalSessionId(
            decision.providerState,
          );
          if (wslTerminalRuntime) {
            launchEnvFactory = async () => {
              try {
                const overlayDir = await createOpenCodeOverlayInWsl();
                return {
                  OPENCODE_CONFIG_DIR: overlayDir,
                  ...(opencodeResumeId
                    ? { TESSERA_OPENCODE_RESUME_ID: opencodeResumeId }
                    : {}),
                };
              } catch (error) {
                logger.error({ error, terminalId }, 'Failed to prepare the OpenCode WSL overlay');
                throw new Error(
                  `Failed to prepare the OpenCode WSL overlay: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            };
          } else {
            const overlay = createOpenCodeOverlay(terminalId);
            resourceDisposers.add(overlay.dispose);
            launchEnv = {
              OPENCODE_CONFIG_DIR: overlay.configDir,
              ...(opencodeResumeId
                ? { TESSERA_OPENCODE_RESUME_ID: opencodeResumeId }
                : {}),
            };
          }
        }

        const completeLaunchEnvFactory = options.prepareControlCliBridge || launchEnvFactory
          ? async (): Promise<Record<string, string | undefined>> => {
              const resolvedEnv: Record<string, string | undefined> = {
                ...(launchEnv ?? {}),
                TESSERA_CONTROL_DESCRIPTOR: undefined,
                TESSERA_CONTROL_DESCRIPTOR_PATH: undefined,
                TESSERA_CLI_CWD: undefined,
                TESSERA_AGENT_ENVIRONMENT: undefined,
              };
              if (launchEnvFactory) {
                Object.assign(resolvedEnv, await launchEnvFactory());
              }
              if (options.prepareControlCliBridge) {
                const bridge = await options.prepareControlCliBridge({
                  agentEnvironment,
                  projectId: callerContext.projectId,
                  sessionId: request.sessionId,
                  ...(callerContext.worktreeId
                    ? { worktreeId: callerContext.worktreeId }
                    : {}),
                });
                resourceDisposers.add(() => {
                  void bridge.dispose().catch((error) => {
                    logger.debug({ error }, 'Control CLI bridge cleanup skipped');
                  });
                });
                Object.assign(resolvedEnv, bridge.environment);
                if (!callerContext.worktreeId) {
                  resolvedEnv.TESSERA_WORKTREE_ID = undefined;
                }
              }
              return resolvedEnv;
            }
          : undefined;

        paneToken = mintPaneToken({
          terminalId,
          userId: request.userId,
          sessionId: request.sessionId,
          providerId: decision.providerId,
        });
        const providerSessionObserver = createTerminalProviderSessionObserver({
          provider: decision.provider,
          currentProviderSessionId: () => {
            const activeSessionId = manager.getSessionIdForTerminal(
              terminalId,
              request.userId,
            ) ?? request.sessionId;
            return getTerminalProviderSessionForTesseraSession(activeSessionId)
              ?.provider_session_id;
          },
          onObservation: ({ activation, identity }) => {
            try {
              options.observeProviderSession?.({
                pane: {
                  terminalId,
                  userId: request.userId,
                  sessionId: request.sessionId,
                  providerId: decision.providerId,
                },
                identity,
                activation,
              });
            } catch (error) {
              logger.warn(
                { error, providerId: decision.providerId, terminalId },
                'Provider session observation could not be reconciled',
              );
            }
          },
        });
        resourceDisposers.add(() => providerSessionObserver.dispose());
        await providerSessionObserver.ready();

        const terminalOptions: Omit<TerminalCreateOptions, 'connectionId' | 'surfaceId'> = {
          userId: request.userId,
          terminalId,
          cwd: workDir,
          sessionId: request.sessionId,
          agentEnvironment,
          ...(request.mode === 'surface'
            ? {
                previewOwnerToken: request.surface.previewOwnerToken,
                cols: request.surface.cols,
                rows: request.surface.rows,
                appearance: request.surface.appearance,
              }
            : {}),
          launchSpec: decision.launchSpec,
          prepareLaunch,
          paneToken,
          providerId: decision.providerId,
          detectConversationReset: decision.provider.detectTerminalConversationReset
            ? (observerOptions) => Boolean(
                decision.provider.detectTerminalConversationReset?.(observerOptions),
              )
            : undefined,
          appearanceChangePolicy: decision.provider.getTerminalAppearanceChangePolicy(),
          resizeScrollbackPolicy: decision.provider.getTerminalResizeScrollbackPolicy(),
          interruptInputPolicy: decision.provider.getTerminalInterruptInputPolicy(),
          canRestartForAppearance:
            decision.provider.getTerminalAppearanceChangePolicy() === 'restart'
              ? () => decision.provider.canResumeTerminalAfterRestart?.(
                  dbSessions.getSession(request.sessionId)?.provider_state ?? null,
                ) ?? false
              : undefined,
          launchEnv: completeLaunchEnvFactory ? undefined : launchEnv,
          launchEnvFactory: completeLaunchEnvFactory,
          launchObserverDisposer: resourceDisposers.asDisposer(),
        };

        transferredToTerminalManager = true;
        if (request.mode === 'surface') {
          await manager.create({
            ...terminalOptions,
            connectionId: request.surface.connectionId,
            surfaceId: request.surface.surfaceId,
          });
        } else {
          await manager.startDetached(terminalOptions);
        }

        return { terminalId, attachedToExistingRuntime: false };
      } catch (error) {
        const managerRuntimeState = manager.getLaunchRuntimeState(
          terminalId,
          request.userId,
          request.sessionId,
        );
        const runtimeState: ProviderLaunchRuntimeState = (
          error instanceof TerminalRuntimeStartError && error.runtimeSpawned
        ) || (
          error instanceof ProviderLaunchError && error.runtimeState === 'spawned'
        )
          ? 'spawned'
          : managerRuntimeState !== 'unowned'
            ? managerRuntimeState
            : error instanceof ProviderLaunchError
              ? error.runtimeState
              : 'unowned';
        if (!transferredToTerminalManager) {
          if (runtimeState !== 'unowned') cleanupLaunchOwnedResources();
          else cleanupBeforeTransfer();
        }
        if (error instanceof ProviderLaunchError) {
          if (error.runtimeState === runtimeState) throw error;
          throw providerLaunchError(
            error.code,
            error.message,
            error.terminalId,
            error.cause,
            runtimeState,
          );
        }
        throw providerLaunchError(
          'LAUNCH_FAILED',
          error instanceof Error ? error.message : 'Failed to launch the provider terminal.',
          terminalId,
          error,
          runtimeState,
        );
      }
  };

  return {
    supportsProvider(providerId): boolean {
      return isSupportedTerminalProvider(providerId);
    },
    async launch(request): Promise<ProviderLaunchResult> {
      validateInitialPrompt(request.initialPrompt);
      const persisted = getPersistedProvider(request);
      const requestedTerminalId = resolveRequestedTerminalId(request);
      const launchKey = JSON.stringify([request.userId, request.sessionId]);
      const activeLaunch = activeLaunches.get(launchKey);
      if (activeLaunch) {
        if (request.mode === 'detached') {
          throw providerLaunchError(
            'SESSION_RUNTIME_ALREADY_RUNNING',
            'The Session already has a live PTY runtime.',
            requestedTerminalId,
          );
        }
        requireFreshConversationForPrompt(true, request.initialPrompt, requestedTerminalId);
        await activeLaunch;
        return launchOnce(request, getPersistedProvider(request), requestedTerminalId);
      }

      const launch = launchOnce(request, persisted, requestedTerminalId);
      activeLaunches.set(launchKey, launch);
      try {
        return await launch;
      } finally {
        if (activeLaunches.get(launchKey) === launch) {
          activeLaunches.delete(launchKey);
        }
      }
    },
  };
}
