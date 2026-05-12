import { ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { ProcessInfo, CliCommandInfo } from './types';
import { protocolAdapter } from './protocol-adapter';
import type { CliProvider, ParsedMessage, ParsedMessageSideEffect, SpawnOptions } from './providers/types';
import type { ContentBlock } from '../ws/message-types';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';
import logger from '../logger';
import { sessionHistory } from '../session-history';
import {
  enqueueProcessInput,
  scheduleNextProcessStdinFlush,
  type QueuedInput,
  writeJsonPayloadToProcessStdin,
  writeQueuedProviderInput,
} from './process-manager-stdin';
import {
  applyManagedParsedMessageSideEffect,
  dispatchManagedParsedMessages,
} from './process-manager-message-dispatch';
import {
  attachManagedProcessHandlers,
  handleManagedProcessError,
  handleManagedProcessExit,
  performManagedProcessHealthCheck,
  routeManagedProcessStdoutLine,
} from './process-manager-runtime';
import { gracefulKillProcess } from './process-termination';

type SessionLifecycle = 'spawned' | 'resumed';
type ControlResponsePayload =
  | { subtype: 'success'; request_id: string; response: Record<string, any> }
  | { subtype: 'error'; request_id: string; error: string };

export class ProcessManager {
  private processes = new Map<string, ProcessInfo>();
  private readonly MAX_PROCESSES = 20;
  private readonly MAX_QUEUE_SIZE = 100;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private stdinQueue = new Map<string, QueuedInput[]>();

  constructor() {
    this.startHealthCheck();
  }

  private createProcessInfo(
    sessionId: string,
    userId: string,
    provider: CliProvider,
    cliProcess: ChildProcess,
    spawnOptions: SpawnOptions,
  ): ProcessInfo {
    const now = new Date();
    return {
      sessionId,
      userId,
      process: cliProcess,
      provider,
      status: 'running',
      isGenerating: false,
      createdAt: now,
      lastActivityAt: now,
      model: spawnOptions.model,
      reasoningEffort: spawnOptions.reasoningEffort,
      serviceTier: spawnOptions.serviceTier,
    };
  }

  private attachSkillSource(processInfo: ProcessInfo): void {
    const skillSource = processInfo.provider.createSkillSource?.(
      processInfo.sessionId,
      processInfo.process,
    );

    if (skillSource) {
      processInfo.skillSource = skillSource;
    }
  }

  private consumeProviderStartupMessages(processInfo: ProcessInfo): ParsedMessage[] {
    return processInfo.provider.consumeStartupMessages?.(
      processInfo.process,
      processInfo.sessionId,
    ) ?? [];
  }

  private registerRunningProcess(
    sessionId: string,
    userId: string,
    provider: CliProvider,
    cliProcess: ChildProcess,
    spawnOptions: SpawnOptions,
    lifecycle: SessionLifecycle,
    cwd?: string,
  ): void {
    const processInfo = this.createProcessInfo(sessionId, userId, provider, cliProcess, spawnOptions);
    this.attachSkillSource(processInfo);

    this.processes.set(sessionId, processInfo);
    const startupMessages = this.consumeProviderStartupMessages(processInfo);
    this.setupProcessHandlers(sessionId, userId, cliProcess);
    this.dispatchParsedMessages(sessionId, userId, startupMessages);
    provider.onSessionReady?.(cliProcess, sessionId);

    logger.info({
      sessionId,
      userId,
      pid: cliProcess.pid,
      provider: provider.getDisplayName(),
      ...(cwd ? { cwd } : {}),
    }, `CLI process ${lifecycle}`);
  }

  private clearSessionRuntimeState(sessionId: string): void {
    this.processes.delete(sessionId);
    this.stdinQueue.delete(sessionId);
  }

  private getProcessOrWarn(sessionId: string, failureMessage: string): ProcessInfo | null {
    const info = this.processes.get(sessionId);
    if (!info) {
      logger.warn({ sessionId }, failureMessage);
      return null;
    }

    return info;
  }

  private getRunningProcessOrWarn(sessionId: string, action: string): ProcessInfo | null {
    const info = this.getProcessOrWarn(sessionId, `Cannot ${action} for non-existent session`);
    if (!info) {
      return null;
    }

    if (info.status !== 'running') {
      logger.warn({ sessionId, status: info.status }, `Cannot ${action} for non-running process`);
      return null;
    }

    return info;
  }

  private tryUpdateProviderSessionConfig(
    sessionId: string,
    patch: {
      permissionMode?: string;
      model?: string;
      reasoningEffort?: string | null;
    } & ProviderRuntimeControls,
    logContext: string,
    logFields: Record<string, unknown>,
  ): boolean {
    const info = this.getProcessOrWarn(sessionId, `Cannot ${logContext} for non-existent session`);
    if (!info) {
      return false;
    }

    const updated = info.provider.updateSessionConfig?.(info.process, patch) ?? false;
    if (updated) {
      if (patch.model !== undefined) {
        info.model = patch.model;
      }
      if (patch.reasoningEffort !== undefined) {
        info.reasoningEffort = patch.reasoningEffort;
      }
      if (patch.serviceTier !== undefined) {
        info.serviceTier = patch.serviceTier;
      }
      logger.info(
        { sessionId, provider: info.provider.getDisplayName(), ...logFields },
        `provider session config updated: ${logContext}`,
      );
    }

    return updated;
  }

  private async replaceExistingProcess(sessionId: string): Promise<void> {
    const existingInfo = this.processes.get(sessionId);
    if (!existingInfo) {
      return;
    }

    await gracefulKillProcess(sessionId, existingInfo.process);
    this.clearSessionRuntimeState(sessionId);
  }

  private async spawnAndRegisterSession(
    sessionId: string,
    userId: string,
    provider: CliProvider,
    cwd: string,
    spawnOptions: SpawnOptions,
    lifecycle: SessionLifecycle,
  ): Promise<boolean> {
    try {
      const { process: cliProcess, ok, error } = await provider.spawn(cwd, spawnOptions);

      if (!ok) {
        logger.error({
          sessionId,
          userId,
          error: error || undefined,
        }, `CLI process failed to ${lifecycle === 'spawned' ? 'spawn' : 'resume'}`);
        return false;
      }

      this.registerRunningProcess(sessionId, userId, provider, cliProcess, spawnOptions, lifecycle, cwd);
      return true;
    } catch (err) {
      logger.error({
        sessionId,
        userId,
        error: err as Error,
      }, `Failed to ${lifecycle === 'spawned' ? 'spawn' : 'resume'} process`);
      this.clearSessionRuntimeState(sessionId);
      return false;
    }
  }

  /**
   * Create a new CLI process session.
   * Pass `sessionIdOverride` to spawn for a known (already-persisted) sessionId;
   * otherwise a fresh UUID is generated.
   */
  async createSession(
    userId: string,
    provider: CliProvider,
    workDir?: string,
    permissionMode?: string,
    model?: string,
    reasoningEffort?: string | null,
    sessionIdOverride?: string,
    controls: ProviderRuntimeControls = {},
  ): Promise<string | null> {
    if (this.processes.size >= this.MAX_PROCESSES) {
      logger.warn({ current: this.processes.size, userId }, 'Process limit reached');
      return null;
    }

    const sessionId = sessionIdOverride ?? uuidv4();
    const cwd = workDir || process.cwd();
    const spawned = await this.spawnAndRegisterSession(
      sessionId,
      userId,
      provider,
      cwd,
      {
        sessionId,
        userId,
        permissionMode,
        model,
        reasoningEffort,
        ...controls,
      },
      'spawned',
    );

    return spawned ? sessionId : null;
  }

  /**
   * Close a session and kill the CLI process
   */
  async closeSession(sessionId: string): Promise<void> {
    const info = this.getProcessOrWarn(sessionId, 'Attempted to close non-existent session');
    if (!info) {
      return;
    }

    logger.info({ sessionId, userId: info.userId }, 'Closing session');
    sessionHistory.flushSession(sessionId);

    await gracefulKillProcess(sessionId, info.process);
    this.clearSessionRuntimeState(sessionId);
  }

  /**
   * Send a message to the CLI process via stdin
   */
  sendMessage(sessionId: string, content: string | ContentBlock[]): void {
    const info = this.getRunningProcessOrWarn(sessionId, 'send message');
    if (!info) {
      return;
    }

    // Mark as generating (user sent a message, CLI will produce a response)
    info.isGenerating = true;
    info.lastActivityAt = new Date();

    const queueLength = enqueueProcessInput(
      this.stdinQueue,
      sessionId,
      content,
      this.MAX_QUEUE_SIZE,
    );

    if (queueLength === 1) {
      this.flushStdinQueue(sessionId);
    }

    logger.debug({
      sessionId,
      queueSize: queueLength,
      maxSize: this.MAX_QUEUE_SIZE,
    }, 'Message queued');
  }

  /**
   * Send interrupt/cancel signal to CLI process (bypasses message queue).
   * Delegates to provider.sendInterrupt() if available, otherwise falls back
   * to Claude Code's control_request format.
   */
  sendInterrupt(sessionId: string): boolean {
    const processInfo = this.getProcessOrWarn(sessionId, 'sendInterrupt: session not found');
    if (!processInfo) {
      return false;
    }

    // Provider-specific interrupt (e.g. Codex turn/interrupt)
    if (processInfo.provider.sendInterrupt) {
      const sent = processInfo.provider.sendInterrupt(processInfo.process, sessionId);
      if (sent) {
        logger.info('Interrupt sent via provider', { sessionId, provider: processInfo.provider.getDisplayName() });
      }
      return sent;
    }

    // Fallback: Claude Code control_request format
    const sent = writeJsonPayloadToProcessStdin(
      processInfo,
      sessionId,
      {
        type: 'control_request',
        request_id: uuidv4(),
        request: { subtype: 'interrupt' },
      },
      'interrupt',
    );

    if (sent) {
      logger.info({ sessionId }, 'Interrupt sent to CLI');
    }

    return sent;
  }

  /**
   * Send set_permission_mode control_request to CLI process
   */
  sendSetPermissionMode(
    sessionId: string,
    mode?: string,
    controls: ProviderRuntimeControls = {},
  ): boolean {
    const patch = {
      ...controls,
      ...(mode && { permissionMode: mode }),
    };

    if (this.tryUpdateProviderSessionConfig(
      sessionId, patch, 'session controls', { mode, ...controls },
    )) {
      return true;
    }
    if (!mode) {
      return false;
    }
    const sent = this.writeControlRequest(
      sessionId, { subtype: 'set_permission_mode', mode }, 'set_permission_mode'
    );
    if (sent) {
      logger.info({ sessionId, mode }, 'set_permission_mode sent to CLI');
    }
    return sent;
  }

  /**
   * Send set_model control_request to CLI process
   */
  sendSetModel(sessionId: string, model: string): boolean {
    if (this.tryUpdateProviderSessionConfig(
      sessionId, { model }, 'model', { model },
    )) {
      return true;
    }

    const sent = this.writeControlRequest(
      sessionId,
      { subtype: 'set_model', model },
      'set_model'
    );
    if (sent) {
      const info = this.processes.get(sessionId);
      if (info) {
        info.model = model;
      }
      logger.info({ sessionId, model }, 'set_model sent to CLI');
    }
    return sent;
  }

  /**
   * Update provider-side reasoning effort / thinking intensity for future turns.
   */
  sendSetReasoningEffort(sessionId: string, reasoningEffort: string | null): boolean {
    return this.tryUpdateProviderSessionConfig(
      sessionId, { reasoningEffort }, 'reasoning effort', { reasoningEffort },
    );
  }

  /**
   * Update provider-side service tier override for future turns.
   */
  sendSetServiceTier(sessionId: string, serviceTier: string | null): boolean {
    return this.tryUpdateProviderSessionConfig(
      sessionId, { serviceTier }, 'service tier', { serviceTier },
    );
  }

  /**
   * Send control_response success payload to CLI.
   */
  sendControlResponseSuccess(
    sessionId: string,
    requestId: string,
    responsePayload: Record<string, any>
  ): boolean {
    return this.writeControlResponse(sessionId, {
      subtype: 'success',
      request_id: requestId,
      response: responsePayload,
    }, 'control_response success');
  }

  /**
   * Send control_response error payload to CLI.
   */
  sendControlResponseError(
    sessionId: string,
    requestId: string,
    errorMessage: string
  ): boolean {
    return this.writeControlResponse(sessionId, {
      subtype: 'error',
      request_id: requestId,
      error: errorMessage,
    }, 'control_response error');
  }

  /**
   * Send legacy interactive tool_result payload.
   */
  sendInteractiveResponse(sessionId: string, toolUseId: string, content: string): boolean {
    return writeJsonPayloadToProcessStdin(
      this.processes.get(sessionId),
      sessionId,
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
      },
      'interactive response',
    );
  }

  /**
   * Get process info by session ID
   */
  getProcess(sessionId: string): ProcessInfo | undefined {
    return this.processes.get(sessionId);
  }

  /**
   * Get all processes
   */
  getAllProcesses(): ProcessInfo[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get active session IDs for quick membership checks.
   */
  getActiveSessionIds(): Set<string> {
    return new Set(this.processes.keys());
  }

  /**
   * Get the SkillSource for a session, or null if the session does not exist
   * or the provider does not support skill discovery.
   */
  getSkillSource(sessionId: string): import('./providers/types').SkillSource | null {
    return this.processes.get(sessionId)?.skillSource ?? null;
  }

  /**
   * Get processes for a specific user
   */
  getUserProcesses(userId: string): ProcessInfo[] {
    return Array.from(this.processes.values()).filter(info => info.userId === userId);
  }

  /**
   * Update process status
   */
  updateStatus(sessionId: string, status: ProcessInfo['status']): void {
    const info = this.processes.get(sessionId);
    if (info) {
      info.status = status;
      logger.debug({ sessionId, status }, 'Process status updated');
    }
  }

  /**
   * Update isGenerating flag (called by protocol-adapter when result is received)
   */
  setIsGenerating(sessionId: string, generating: boolean): void {
    const info = this.processes.get(sessionId);
    if (info) {
      info.isGenerating = generating;
      logger.debug({ sessionId, generating }, 'Process isGenerating updated');
    }
  }

  /**
   * Get session IDs that are currently generating a response.
   */
  getGeneratingSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const [sessionId, info] of this.processes.entries()) {
      if (info.isGenerating) {
        ids.add(sessionId);
      }
    }
    return ids;
  }

  getSessionRuntimeConfigs(): Map<string, Pick<ProcessInfo, 'model' | 'reasoningEffort' | 'serviceTier'>> {
    const configs = new Map<string, Pick<ProcessInfo, 'model' | 'reasoningEffort' | 'serviceTier'>>();
    for (const [sessionId, info] of this.processes.entries()) {
      configs.set(sessionId, {
        model: info.model,
        reasoningEffort: info.reasoningEffort,
        serviceTier: info.serviceTier,
      });
    }
    return configs;
  }

  /**
   * Cleanup all processes (server shutdown)
   */
  async cleanup(): Promise<void> {
    logger.info({ count: this.processes.size }, 'Cleaning up all processes');

    const cleanupPromises: Promise<void>[] = [];
    for (const [sessionId, info] of this.processes.entries()) {
      cleanupPromises.push(gracefulKillProcess(sessionId, info.process));
    }

    await Promise.all(cleanupPromises);

    this.processes.clear();
    this.stdinQueue.clear();

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    logger.info('All processes cleaned up');
  }

  /**
   * Resume an existing session
   */
  async resumeSession(
    sessionId: string,
    userId: string,
    provider: CliProvider,
    workDir?: string,
    permissionMode?: string,
    model?: string,
    reasoningEffort?: string | null,
    extraSpawnOptions?: Partial<SpawnOptions>,
  ): Promise<string | null> {
    await this.replaceExistingProcess(sessionId);
    const cwd = workDir || process.cwd();
    const resumed = await this.spawnAndRegisterSession(
      sessionId,
      userId,
      provider,
      cwd,
      {
        sessionId,
        resume: true,
        permissionMode,
        model,
        reasoningEffort,
        ...extraSpawnOptions,
        userId,
      },
      'resumed',
    );

    return resumed ? sessionId : null;
  }

  private routeStdoutLine(sessionId: string, userId: string, line: string): void {
    routeManagedProcessStdoutLine({
      processes: this.processes,
      sessionId,
      userId,
      line,
      fallbackParseStdout: (nextSessionId, nextUserId, nextLine) => {
        protocolAdapter.parseStdout(nextSessionId, nextUserId, nextLine);
      },
      dispatchParsedMessages: (nextSessionId, nextUserId, messages) => {
        this.dispatchParsedMessages(nextSessionId, nextUserId, messages);
      },
    });
  }

  /**
   * Setup event handlers for a CLI process
   */
  private setupProcessHandlers(sessionId: string, userId: string, cliProcess: ChildProcess): void {
    attachManagedProcessHandlers({
      processes: this.processes,
      sessionId,
      userId,
      cliProcess,
      routeStdoutLine: (nextSessionId, nextUserId, line) => {
        this.routeStdoutLine(nextSessionId, nextUserId, line);
      },
      handleProcessExit: (nextSessionId, nextUserId, code, signal) => {
        this.handleProcessExit(nextSessionId, nextUserId, code, signal);
      },
      handleProcessError: (nextSessionId, error) => {
        this.handleProcessError(nextSessionId, error);
      },
    });
  }

  /**
   * Send ParsedMessage results to the client via protocolAdapter's sendToUser,
   * and apply any side effects to processManager state.
   */
  private dispatchParsedMessages(sessionId: string, userId: string, messages: ParsedMessage[]): void {
    dispatchManagedParsedMessages({
      sessionId,
      userId,
      messages,
      getSendToUser: () => protocolAdapter.getSendToUser(),
      applyParsedMessageSideEffect: (targetSessionId, targetUserId, sideEffect) => {
        this.applyParsedMessageSideEffect(targetSessionId, targetUserId, sideEffect);
      },
    });
  }

  private handleProcessExit(
    sessionId: string,
    userId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    handleManagedProcessExit({
      processes: this.processes,
      sessionId,
      userId,
      code,
      signal,
      clearSessionRuntimeState: (targetSessionId) => {
        this.clearSessionRuntimeState(targetSessionId);
      },
      dispatchParsedMessages: (targetSessionId, targetUserId, messages) => {
        this.dispatchParsedMessages(targetSessionId, targetUserId, messages);
      },
      fallbackHandleProcessExit: (targetSessionId, targetUserId, exitCode) => {
        protocolAdapter.handleProcessExit(targetSessionId, targetUserId, exitCode);
      },
    });
  }

  private handleProcessError(sessionId: string, err: Error): void {
    handleManagedProcessError(sessionId, err, (targetSessionId) => {
      this.clearSessionRuntimeState(targetSessionId);
    });
  }

  private applyParsedMessageSideEffect(
    sessionId: string,
    userId: string,
    sideEffect: ParsedMessageSideEffect,
  ): void {
    applyManagedParsedMessageSideEffect({
      processes: this.processes,
      sessionId,
      userId,
      sideEffect,
      setIsGenerating: (targetSessionId, generating) => {
        this.setIsGenerating(targetSessionId, generating);
      },
      autoGenerateTitle: (targetSessionId, targetUserId) => {
        protocolAdapter.maybeAutoGenerateTitle(targetSessionId, targetUserId);
      },
    });
  }

  /**
   * Flush stdin message queue.
   * Delegates the actual message formatting and stdin write to the provider.
   */
  private async flushStdinQueue(sessionId: string): Promise<void> {
    const queue = this.stdinQueue.get(sessionId);
    if (!queue || queue.length === 0) return;

    const info = this.getRunningProcessOrWarn(sessionId, 'flush stdin queue');
    if (!info) return;

    const content = queue[0];
    const ok = writeQueuedProviderInput(this.stdinQueue, sessionId, info, content);
    queue.shift();
    scheduleNextProcessStdinFlush(
      this.stdinQueue,
      sessionId,
      info,
      ok,
      () => {
        void this.flushStdinQueue(sessionId);
      },
    );
  }

  /**
   * Store commands received from CLI initialize response.
   */
  storeCommands(sessionId: string, commands: CliCommandInfo[]): void {
    const info = this.processes.get(sessionId);
    if (info) {
      info.commands = commands;
      logger.info({ sessionId, count: commands.length }, 'CLI commands stored');
    }
  }

  /**
   * Get commands for a session (from CLI initialize response).
   */
  getCommands(sessionId: string): CliCommandInfo[] {
    return this.processes.get(sessionId)?.commands ?? [];
  }

  private writeControlRequest(
    sessionId: string,
    request: Record<string, any>,
    logContext: string,
  ): boolean {
    return writeJsonPayloadToProcessStdin(
      this.processes.get(sessionId),
      sessionId,
      {
        type: 'control_request',
        request_id: uuidv4(),
        request,
      },
      logContext,
    );
  }

  private writeControlResponse(
    sessionId: string,
    response: ControlResponsePayload,
    logContext: string,
  ): boolean {
    return writeJsonPayloadToProcessStdin(
      this.processes.get(sessionId),
      sessionId,
      {
        type: 'control_response',
        response,
      },
      logContext,
    );
  }

  /**
   * Start health check interval
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 5000); // 5s interval
  }

  /**
   * Perform health check on all processes
   */
  private performHealthCheck(): void {
    performManagedProcessHealthCheck(this.processes);
  }
}

// Singleton instance (globalThis to survive Next.js hot reload and webpack/tsx module boundary)
const PM_KEY = Symbol.for('tessera.processManager');
const _g = globalThis as unknown as Record<symbol, ProcessManager>;
export const processManager: ProcessManager = _g[PM_KEY] || (_g[PM_KEY] = new ProcessManager());
