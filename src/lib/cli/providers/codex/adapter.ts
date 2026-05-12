/**
 * Codex CLI Adapter
 *
 * Implements the CliProvider interface for the Codex CLI (app-server mode).
 * Encapsulates all Codex-specific logic:
 *  - CLI argument construction (app-server subcommand)
 *  - Process spawning with JSON-RPC 2.0 handshake (initialize + thread/start)
 *  - stdin message protocol (turn/start JSON-RPC notifications)
 *  - stdout parsing via CodexProtocolParser
 *  - Title generation via codex exec --json agent_message parsing
 *
 * Codex app-server protocol overview:
 *  1. Spawn `codex app-server`
 *  2. Write initialize request (id=1, protocolVersion "2025-01-01")
 *  3. Await response id=1 (server confirms protocol)
 *  4. Write thread/start request (id=2)
 *  5. Await response id=2 (server returns threadId)
 *  6. For each user turn: write turn/start notification with user input text
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';
import type {
  CliProvider,
  SpawnOptions,
  SpawnResult,
  ParsedMessage,
  GeneratedTitle,
  SkillSource,
  SkillInfo,
  CheckStatusOptions,
  CliStatusResult,
  CliRawLogSink,
} from '../types';
import type { ContentBlock } from '@/lib/ws/message-types';
import type {
  CodexApprovalPolicy,
  CodexCollaborationMode,
  CodexSandboxMode,
  ProviderRuntimeControls,
} from '@/lib/session/session-control-types';
import { codexProtocolParser } from './protocol-parser';
import { buildCodexSandboxPolicy, getCodexPermissionMapping } from './session-config';
import { isBinaryAvailable } from '../registry';
import { getAgentEnvironment, normalizeCwdForCliEnvironment, spawnCli } from '../../spawn-cli';
import { execCli, parseVersion, probeBinaryAvailable } from '../../cli-exec';
import {
  resolveProviderCliCommand,
  resolveProviderCliCommandWithMetadata,
} from '../../provider-command';
import {
  classifyAuthFailure,
  classifyVersionFailure,
  summarizeExecProbe,
} from '../../status-detection';
import { updateProviderStateWithRetry } from '../../process-manager-side-effects';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import logger from '@/lib/logger';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';

const CLI_TIMEOUT_MS = 120_000;
const STATUS_CHECK_TIMEOUT_MS = 5_000;
const TITLE_REASONING_EFFORT = 'low';
const PROVIDER_ID = 'codex';
const DEFAULT_COMMAND = 'codex';
const CODEX_ATTACHMENTS_DIR = getTesseraDataPath('attachments', 'codex');

type CodexInputItem =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'localImage'; path: string };

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'img';
  }
}

function persistCodexImage(sessionId: string, block: Extract<ContentBlock, { type: 'image' }>): string {
  const dir = path.join(CODEX_ATTACHMENTS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filename = `${Date.now()}-${randomUUID()}.${extensionForMediaType(block.source.media_type)}`;
  const filePath = path.join(dir, filename);
  const data = Buffer.from(block.source.data, 'base64');

  fs.writeFileSync(filePath, data, { mode: 0o600 });
  return filePath;
}

/**
 * JSON-RPC 2.0 request / notification shapes used in the Codex protocol.
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResultResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: Record<string, unknown>;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface CodexRuntimeConfig {
  sessionId: string;
  cwd: string;
  permissionMode?: string;
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  collaborationMode?: CodexCollaborationMode;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
}

function resolveCodexAccessConfig(runtimeConfig?: CodexRuntimeConfig): {
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
} | null {
  if (!runtimeConfig) {
    return null;
  }

  if (runtimeConfig.approvalPolicy && runtimeConfig.sandboxMode) {
    return {
      approvalPolicy: runtimeConfig.approvalPolicy,
      sandboxMode: runtimeConfig.sandboxMode,
    };
  }

  if (runtimeConfig.permissionMode) {
    const mapping = getCodexPermissionMapping(runtimeConfig.permissionMode, runtimeConfig.cwd);
    return {
      approvalPolicy: mapping.approvalPolicy,
      sandboxMode: mapping.sandboxMode,
    };
  }

  return null;
}

function buildCodexCollaborationMode(runtimeConfig: CodexRuntimeConfig): Record<string, unknown> | null {
  if (!runtimeConfig.collaborationMode) {
    return null;
  }

  const model = runtimeConfig.model?.trim();
  if (!model) {
    return null;
  }

  return {
    mode: runtimeConfig.collaborationMode,
    settings: {
      model,
      reasoning_effort: runtimeConfig.reasoningEffort ?? null,
      developer_instructions: null,
    },
  };
}

function extractCodexActiveModel(response: { result?: Record<string, any> }): string | null {
  const model = response.result?.model ?? response.result?.thread?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

// =============================================================================
// CodexAdapter
// =============================================================================

export class CodexAdapter implements CliProvider {
  /**
   * Counter for JSON-RPC request IDs used by sendMessage / sendInterrupt.
   * Starts at 3 because the handshake reserves local ids 1 and 2 (initialize
   * and thread/start|resume). This avoids id collisions when the handshake
   * response is still being parsed.
   */
  private _nextRequestId = 3;

  /**
   * Maps a CLI child process to its Codex threadId (set during handshake).
   * WeakMap ensures cleanup when the process is GC'd.
   */
  private _processThreadIds = new WeakMap<ChildProcess, string>();
  private _processRuntimeConfig = new WeakMap<ChildProcess, CodexRuntimeConfig>();
  private _processRawLogs = new WeakMap<ChildProcess, CliRawLogSink>();

  private _attachRawLog(
    proc: ChildProcess,
    rawLog: CliRawLogSink | undefined,
    metadata: Record<string, unknown>,
  ): void {
    if (!rawLog) return;

    this._processRawLogs.set(proc, rawLog);
    rawLog({ direction: 'event', phase: 'spawn', data: JSON.stringify(metadata) });
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      rawLog({ direction: 'stdout', phase: 'process', data: chunk.toString() });
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      rawLog({ direction: 'stderr', phase: 'process', data: chunk.toString() });
    });
  }

  private _writeStdin(proc: ChildProcess, phase: string, payload: string): boolean {
    this._processRawLogs.get(proc)?.({ direction: 'stdin', phase, data: payload });
    return proc.stdin?.write(payload) ?? false;
  }

  // ---------------------------------------------------------------------------
  // CliProvider: getProviderId / getDisplayName
  // ---------------------------------------------------------------------------

  getProviderId(): string {
    return PROVIDER_ID;
  }

  getDisplayName(): string {
    return 'Codex';
  }

  // ---------------------------------------------------------------------------
  // CliProvider: isAvailable
  // ---------------------------------------------------------------------------

  async isAvailable(environment?: 'native' | 'wsl'): Promise<boolean> {
    if (environment) {
      return probeBinaryAvailable('codex', environment);
    }
    return isBinaryAvailable('codex');
  }

  /**
   * Checks whether Codex is installed and the user is logged in.
   * Runs version/auth probes in parallel so provider pickers are not blocked
   * by serial CLI startup costs on Windows.
   */
  async checkStatus(options: CheckStatusOptions): Promise<CliStatusResult> {
    const commandMetadata = await resolveProviderCliCommandWithMetadata(
      PROVIDER_ID,
      DEFAULT_COMMAND,
      options.environment,
      options.userId,
    );
    const command = commandMetadata.command;
    const [versionResult, loginResult] = await Promise.all([
      execCli(
        command,
        ['--version'],
        options.environment,
        STATUS_CHECK_TIMEOUT_MS,
      ),
      execCli(
        command,
        ['login', 'status'],
        options.environment,
        STATUS_CHECK_TIMEOUT_MS,
      ),
    ]);
    const versionProbe = summarizeExecProbe(versionResult);
    const authProbe = summarizeExecProbe(loginResult);
    const baseTelemetry = {
      commandSource: commandMetadata.commandSource,
      commandShape: commandMetadata.commandShape,
      versionProbe,
      authProbe,
    };

    if (!versionResult.ok) {
      return {
        status: 'not_installed',
        detectionReason: classifyVersionFailure(versionResult, commandMetadata.commandSource),
        ...baseTelemetry,
      };
    }

    const version = parseVersion(versionResult.stdout);
    const connected = loginResult.ok;

    return {
      status: connected ? 'connected' : 'needs_login',
      detectionReason: connected ? 'connected' : classifyAuthFailure(loginResult),
      ...(version ? { version } : {}),
      ...baseTelemetry,
    };
  }

  // ---------------------------------------------------------------------------
  // CliProvider: getCliArgs
  // ---------------------------------------------------------------------------

  /**
   * Returns the CLI argument list for spawning Codex in app-server mode.
   * The `sessionId` and other SpawnOptions are ignored because the Codex
   * app-server protocol handles session state via thread/start requests
   * rather than CLI flags.
   */
  getCliArgs(_options: SpawnOptions): string[] {
    return ['app-server'];
  }

  // ---------------------------------------------------------------------------
  // CliProvider: spawn
  // ---------------------------------------------------------------------------

  /**
   * Spawns the Codex CLI in app-server mode and performs the JSON-RPC
   * initialization handshake:
   *  1. Spawn `codex app-server`
   *  2. Write initialize request (id=1, protocolVersion "2025-01-01")
   *  3. Await response id=1
   *  4. Write thread/start request (id=2)
   *  5. Await response id=2, extract threadId
   *  6. Store threadId on the protocol parser
   *
   * The sessionId in SpawnOptions is used to key the parser's per-session state.
   */
  async spawn(workDir: string, options: SpawnOptions): Promise<SpawnResult> {
    const args = this.getCliArgs(options);
    const agentEnv = await getAgentEnvironment(options.userId);
    const command = await resolveProviderCliCommand(PROVIDER_ID, DEFAULT_COMMAND, agentEnv, options.userId);
    const cliWorkDir = normalizeCwdForCliEnvironment(workDir, agentEnv);

    const cliProcess = spawnCli(command, args, {
      cwd: cliWorkDir,
      shell: false,
      env: process.env as NodeJS.ProcessEnv,
      detached: getRuntimePlatform() !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }, agentEnv);
    this._attachRawLog(cliProcess, options.rawLog, {
      providerId: PROVIDER_ID,
      command,
      args,
      cwd: cliWorkDir,
      requestedCwd: workDir,
      agentEnv,
    });

    // Wait for spawn or error event
    const spawnResult = await new Promise<{ ok: boolean; error?: Error }>((resolve) => {
      const onError = (err: Error) => {
        cliProcess.removeListener('spawn', onSpawn);
        resolve({ ok: false, error: err });
      };
      const onSpawn = () => {
        cliProcess.removeListener('error', onError);
        resolve({ ok: true });
      };
      cliProcess.once('error', onError);
      cliProcess.once('spawn', onSpawn);
    });

    if (!spawnResult.ok) {
      return { process: cliProcess, ok: false, error: spawnResult.error };
    }

    this._processRuntimeConfig.set(cliProcess, {
      sessionId: options.sessionId ?? '__provider__',
      cwd: cliWorkDir,
      permissionMode: options.permissionMode,
      model: options.model,
      reasoningEffort: options.reasoningEffort ?? null,
      serviceTier: options.serviceTier,
      collaborationMode: options.collaborationMode as CodexCollaborationMode | undefined,
      approvalPolicy: options.approvalPolicy as CodexApprovalPolicy | undefined,
      sandboxMode: options.sandboxMode as CodexSandboxMode | undefined,
    });

    codexProtocolParser.setSessionModel(options.sessionId ?? '__provider__', options.model);

    // Perform JSON-RPC handshake
    try {
      await this._performHandshake(cliProcess, options.sessionId ?? '__provider__', options);
    } catch (err) {
      logger.error('CodexAdapter: handshake failed', {
        error: (err as Error).message,
        sessionId: options.sessionId,
      });
      cliProcess.kill('SIGTERM');
      return {
        process: cliProcess,
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    return { process: cliProcess, ok: true };
  }

  // ---------------------------------------------------------------------------
  // CliProvider: sendMessage
  // ---------------------------------------------------------------------------

  /**
   * Writes a user turn to the Codex app-server stdin as a JSON-RPC 2.0
   * request:
   *   { "jsonrpc": "2.0", "id": N, "method": "turn/start",
   *     "params": { "threadId": "<id>", "input": [...] } }
   *
   * Codex requires `input` to be an array of items and `threadId` from the
   * handshake. When content is an array of ContentBlock:
   *   - text blocks  → { type: 'text', text: '...' }
   *   - skill blocks → { type: 'skill', name: '...', path: '...' }
   *   - image blocks → persisted to ~/.tessera/attachments/codex/{sessionId}
   *                    and sent as { type: 'localImage', path: '...' }
   *
   * When content is a plain string it is wrapped in a single text item.
   */
  sendMessage(proc: ChildProcess, content: string | ContentBlock[]): boolean {
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    const attachmentSessionId = runtimeConfig?.sessionId ?? '__provider__';

    const inputItems: CodexInputItem[] = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : (content
          .map((b): CodexInputItem | null => {
            if (b.type === 'text') {
              return { type: 'text', text: b.text };
            }
            if (b.type === 'skill') {
              return { type: 'skill', name: b.name, path: b.path };
            }
            if (b.type === 'image') {
              return { type: 'localImage', path: persistCodexImage(attachmentSessionId, b) };
            }
            return null;
          })
          .filter((item): item is CodexInputItem => item !== null));

    const threadId = this._processThreadIds.get(proc);
    if (!threadId) {
      logger.error('CodexAdapter: cannot send turn/start — no threadId for this process');
      return false;
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this._nextRequestId++,
      method: 'turn/start',
      params: {
        threadId,
        input: inputItems,
      },
    };

    if (runtimeConfig?.model) {
      request.params = { ...request.params, model: runtimeConfig.model };
    }
    if (runtimeConfig?.reasoningEffort) {
      request.params = { ...request.params, effort: runtimeConfig.reasoningEffort };
    }
    if (runtimeConfig?.serviceTier !== undefined) {
      request.params = { ...request.params, serviceTier: runtimeConfig.serviceTier };
    }
    const accessConfig = resolveCodexAccessConfig(runtimeConfig);
    if (accessConfig) {
      request.params = {
        ...request.params,
        approvalPolicy: accessConfig.approvalPolicy,
        sandboxPolicy: buildCodexSandboxPolicy(accessConfig.sandboxMode, runtimeConfig?.cwd ?? process.cwd()),
      };
    }
    if (runtimeConfig) {
      const collaborationMode = buildCodexCollaborationMode(runtimeConfig);
      if (collaborationMode) {
        request.params = { ...request.params, collaborationMode };
      }
    }

    const ok = this._writeStdin(proc, 'send_message', `${JSON.stringify(request)}\n`);
    logger.debug('CodexAdapter: sent turn/start', { inputItemCount: inputItems.length, threadId });
    return ok;
  }

  onSessionReady(proc: ChildProcess, sessionId: string): boolean {
    const requestId = this._nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'account/rateLimits/read',
    };

    codexProtocolParser.trackPendingRequest(sessionId, requestId, 'account/rateLimits/read');
    const ok = this._writeStdin(proc, 'on_session_ready', `${JSON.stringify(request)}\n`);
    logger.debug('CodexAdapter: requested initial rate limits', { sessionId, requestId, ok });
    return ok;
  }

  // ---------------------------------------------------------------------------
  // CliProvider: parseStdout
  // ---------------------------------------------------------------------------

  /**
   * Parses a single stdout line from the Codex app-server.
   * Delegates to the CodexProtocolParser singleton and returns the first
   * ParsedMessage produced by the line, or null if the line is suppressed.
   *
   * The parser is keyed with a fixed provider-level session ID since
   * CliProvider.parseStdout() has no sessionId parameter. Per-session state is
   * maintained by the protocol-adapter when session IDs are known.
   */
  parseStdout(line: string): ParsedMessage | null {
    const messages = this.parseSessionStdout('__provider__', line);
    return messages.length > 0 ? messages[0] : null;
  }

  /**
   * Parses a stdout line using the real Tessera session ID so Codex parser state
   * stays fully encapsulated inside the provider boundary.
   */
  parseSessionStdout(sessionId: string, line: string): ParsedMessage[] {
    return codexProtocolParser.parseStdout(sessionId, line);
  }

  /**
   * Clears Codex parser state when the process exits and returns any exit
   * notifications for ProcessManager to dispatch.
   */
  handleSessionExit(sessionId: string, exitCode: number): ParsedMessage[] {
    return codexProtocolParser.handleProcessExit(sessionId, exitCode);
  }

  // ---------------------------------------------------------------------------
  // CliProvider: sendApprovalResponse
  // ---------------------------------------------------------------------------

  /**
   * Sends a JSON-RPC 2.0 response to a Codex server-initiated approval request.
   *
   * Codex uses server-initiated JSON-RPC requests (method: item/commandExecution/requestApproval,
   * item/fileChange/requestApproval) and expects a JSON-RPC response on stdin:
   *   { "jsonrpc": "2.0", "id": <requestId>, "result": { "decision": "accept" | "decline" } }
   *
   * @param proc - The live Codex CLI child process.
   * @param requestId - The JSON-RPC request id from the server's approval request.
   * @param decision - 'accept' to approve or 'decline' to reject.
   */
  sendApprovalResponse(proc: ChildProcess, requestId: string, decision: 'accept' | 'decline'): void {
    this.sendJsonRpcResponse(proc, requestId, { decision });
    logger.info('CodexAdapter: sent approval response', { requestId, decision });
  }

  /**
   * Sends a JSON-RPC 2.0 response for a Codex server-initiated request.
   */
  sendJsonRpcResponse(proc: ChildProcess, requestId: string, result: Record<string, unknown>): void {
    const numericId = Number(requestId);
    const id = !isNaN(numericId) ? numericId : requestId;

    const response: JsonRpcResultResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };

    this._writeStdin(proc, 'send_json_rpc_response', `${JSON.stringify(response)}\n`);
    logger.debug('CodexAdapter: sent JSON-RPC response', { requestId });
  }

  /**
   * Sends a JSON-RPC 2.0 error response for unsupported Codex server requests.
   */
  sendJsonRpcError(
    proc: ChildProcess,
    requestId: string,
    error: { code: number; message: string; data?: unknown },
  ): void {
    const numericId = Number(requestId);
    const id = !isNaN(numericId) ? numericId : requestId;

    const response: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id,
      error,
    };

    this._writeStdin(proc, 'send_json_rpc_error', `${JSON.stringify(response)}\n`);
    logger.debug('CodexAdapter: sent JSON-RPC error response', {
      requestId,
      code: error.code,
    });
  }

  // ---------------------------------------------------------------------------
  // CliProvider: sendInterrupt
  // ---------------------------------------------------------------------------

  /**
   * Sends a `turn/interrupt` JSON-RPC request to abort the current generation.
   * Requires both threadId (from handshake) and turnId (from turn/started).
   *
   * Returns true if the request was written to stdin, false if missing state.
   */
  sendInterrupt(proc: ChildProcess, sessionId: string): boolean {
    const threadId = this._processThreadIds.get(proc);
    if (!threadId) {
      logger.warn('CodexAdapter: sendInterrupt — no threadId for this process', { sessionId });
      return false;
    }

    const turnId = codexProtocolParser.getActiveTurnId(sessionId);
    if (!turnId) {
      logger.warn('CodexAdapter: sendInterrupt — no active turnId', { sessionId });
      return false;
    }

    const requestId = this._nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'turn/interrupt',
      params: { threadId, turnId },
    };

    codexProtocolParser.trackPendingRequest(sessionId, requestId, 'turn/interrupt');
    this._writeStdin(proc, 'send_interrupt', `${JSON.stringify(request)}\n`);
    logger.info('CodexAdapter: sent turn/interrupt', { sessionId, threadId, turnId });
    return true;
  }

  updateSessionConfig(
    proc: ChildProcess,
    patch: ProviderRuntimeControls & {
      permissionMode?: string;
      model?: string;
      reasoningEffort?: string | null;
    },
  ): boolean {
    const current = this._processRuntimeConfig.get(proc);
    if (!current) {
      return false;
    }

    this._processRuntimeConfig.set(proc, {
      ...current,
      ...patch,
      reasoningEffort:
        patch.reasoningEffort !== undefined
          ? patch.reasoningEffort
          : current.reasoningEffort,
      serviceTier:
        patch.serviceTier !== undefined
          ? patch.serviceTier
          : current.serviceTier,
    });

    if (patch.model) {
      codexProtocolParser.setSessionModel(current.sessionId, patch.model);
    }

    logger.info('CodexAdapter: queued runtime config update for next turn', {
      sessionId: current.sessionId,
      patch,
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // CliProvider: createSkillSource
  // ---------------------------------------------------------------------------

  /**
   * Creates a SkillSource bound to a specific session's CLI process.
   *
   * The returned SkillSource.listSkills() sends a `skills/list` JSON-RPC
   * request to the running Codex app-server and parses the response:
   *   result.skills = Array<{ cwd, skills: Array<SkillMetadata>, errors }>
   *   SkillMetadata: { name, description, path, scope, enabled }
   *
   * Only skills where `enabled` is not false are included. Names are truncated
   * to 100 chars, descriptions to 500 chars. Entries with empty names are
   * filtered out. The `path` field from SkillMetadata is preserved in SkillInfo.
   *
   * Returns null if no threadId is available for the process.
   */
  createSkillSource(sessionId: string, proc: ChildProcess): SkillSource | null {
    return {
      listSkills: async (): Promise<SkillInfo[]> => {
        const threadId = this._processThreadIds.get(proc);
        if (!threadId) {
          logger.debug('CodexAdapter: createSkillSource.listSkills — no threadId', { sessionId });
          return [];
        }

        if (!proc.stdin?.writable) {
          logger.debug('CodexAdapter: createSkillSource.listSkills — stdin not writable', { sessionId });
          return [];
        }

        const requestId = this._nextRequestId++;
        const request: JsonRpcRequest = {
          jsonrpc: '2.0',
          id: requestId,
          method: 'skills/list',
          params: { threadId },
        };

        codexProtocolParser.trackPendingRequest(sessionId, requestId, 'skills/list');
        this._writeStdin(proc, 'skills_list', `${JSON.stringify(request)}\n`);
        logger.debug('CodexAdapter: sent skills/list request', { sessionId, requestId, threadId });

        let response: { id: number; result?: Record<string, any>; error?: any };
        try {
          response = await this._awaitResponse(proc, requestId, 'skills/list');
        } catch (err) {
          logger.warn('CodexAdapter: skills/list request failed', {
            sessionId,
            error: (err as Error).message,
          });
          return [];
        }

        // Parse ListSkillsResponseEvent
        // Actual shape: result.data = Array<{ cwd, skills: Array<SkillMetadata>, errors }>
        // SkillMetadata: { name, description, path, scope, enabled }
        const skillGroups: any[] = response?.result?.data ?? [];
        const entries: SkillInfo[] = [];

        for (const group of skillGroups) {
          for (const skill of group.skills ?? []) {
            // Skip skills explicitly disabled (enabled === false); include when enabled is true or undefined
            if (skill.enabled === false) continue;

            const name = String(skill.name ?? '').slice(0, 100);
            const description = String(skill.description ?? '').slice(0, 500);

            // Filter out entries with empty names
            if (!name) continue;

            const entry: SkillInfo = { name, description };
            if (skill.path != null) {
              entry.path = String(skill.path);
            }
            entries.push(entry);
          }
        }

        logger.debug('CodexAdapter: skills/list parsed', { sessionId, count: entries.length });
        return entries;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // CliProvider: generateTitle
  // ---------------------------------------------------------------------------

  /**
   * Generates a session title by spawning `codex exec --json` with the prompt
   * and parsing the completed agent message from JSONL stdout.
   *
   * Returns null if no valid JSON title is produced or if title generation
   * fails for any reason.
   */
  async generateTitle(prompt: string, userId?: string): Promise<GeneratedTitle | null> {
    try {
      return await this._generateTitleViaExec(prompt, userId);
    } catch (err) {
      logger.warn('CodexAdapter: generateTitle failed', {
        error: (err as Error).message,
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: JSON-RPC handshake
  // ---------------------------------------------------------------------------

  /**
   * Performs the Codex app-server initialization handshake:
   *  1. Writes initialize request (id=1)
   *  2. Awaits success response with id=1
   *  3. Determines thread method: thread/resume (if options.resume && options.threadId)
   *     or thread/start (new session or fallback when threadId is missing)
   *  4. Writes the thread request (id=2)
   *  5. Awaits response with id=2 and extracts threadId
   *  6. Stores threadId on the protocol parser for the given sessionId
   *
   * Uses a local nextId counter (starting at 1) to avoid interleaving with the
   * singleton this._nextRequestId used by sendMessage / sendInterrupt.
   */
  private async _performHandshake(
    proc: ChildProcess,
    sessionId: string,
    options?: SpawnOptions,
  ): Promise<void> {
    // Local counter: ids 1 and 2 are reserved for handshake steps.
    // Using a local counter prevents id interleaving when multiple spawns
    // happen concurrently before any sendMessage calls.
    let nextId = 1;

    // Step 1: Send initialize request
    const initId = nextId++;
    const initRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-01-01',
        clientInfo: { name: 'tessera', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    };

    codexProtocolParser.trackPendingRequest(sessionId, initId, 'initialize');
    this._writeStdin(proc, 'handshake_initialize', `${JSON.stringify(initRequest)}\n`);
    logger.info('CodexAdapter: sent initialize request', { sessionId, id: initId });

    // Step 2: Await initialize response
    const startupTimeoutMs = options?.startupTimeoutMs ?? CLI_TIMEOUT_MS;
    await this._awaitResponse(proc, initId, 'initialize', startupTimeoutMs);
    logger.info('CodexAdapter: initialize handshake complete', { sessionId });

    // Step 3: Determine whether to resume an existing thread or start a new one
    const isResume = options?.resume === true && !!options?.threadId;

    if (options?.resume === true && !options?.threadId) {
      logger.warn(
        'CodexAdapter: resume=true but no threadId provided — falling back to thread/start',
        { sessionId },
      );
    }

    const threadMethod = isResume ? 'thread/resume' : 'thread/start';
    const runtimeConfig = this._processRuntimeConfig.get(proc);
    const threadParams: Record<string, unknown> = isResume
      ? { threadId: options!.threadId }
      : {};

    if (runtimeConfig?.model) {
      threadParams.model = runtimeConfig.model;
    }
    if (runtimeConfig?.serviceTier !== undefined) {
      threadParams.serviceTier = runtimeConfig.serviceTier;
    }
    const accessConfig = resolveCodexAccessConfig(runtimeConfig);
    if (accessConfig) {
      threadParams.approvalPolicy = accessConfig.approvalPolicy;
      threadParams.sandbox = accessConfig.sandboxMode;
    }

    // Step 4: Send thread/start or thread/resume request
    const threadReqId = nextId++;
    const threadRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: threadReqId,
      method: threadMethod,
      params: threadParams,
    };

    codexProtocolParser.trackPendingRequest(sessionId, threadReqId, threadMethod);
    this._writeStdin(proc, `handshake_${threadMethod}`, `${JSON.stringify(threadRequest)}\n`);
    logger.info(`CodexAdapter: sent ${threadMethod} request`, { sessionId, id: threadReqId });

    // Step 5: Await thread response and extract threadId
    const threadResponse = await this._awaitResponse(proc, threadReqId, threadMethod, startupTimeoutMs);
    const activeModel = extractCodexActiveModel(threadResponse);
    if (activeModel) {
      const currentConfig = this._processRuntimeConfig.get(proc);
      if (currentConfig) {
        this._processRuntimeConfig.set(proc, { ...currentConfig, model: activeModel });
      }
      codexProtocolParser.setSessionModel(sessionId, activeModel);
    }

    // Step 6: Store threadId returned by server (at result.thread.id or result.threadId)
    const serverThreadId = threadResponse?.result?.thread?.id ?? threadResponse?.result?.threadId;
    if (serverThreadId) {
      const tid = String(serverThreadId);
      codexProtocolParser.setThreadId(sessionId, tid);
      this._processThreadIds.set(proc, tid);
      if (sessionId !== '__provider__') {
        updateProviderStateWithRetry(sessionId, { threadId: tid });
      }
      logger.info(`CodexAdapter: ${threadMethod} handshake complete`, {
        sessionId,
        serverThreadId: tid,
      });
    } else {
      logger.warn(`CodexAdapter: ${threadMethod} response missing threadId`, {
        sessionId,
        response: threadResponse,
      });
    }
  }

  /**
   * Reads lines from the process stdout until it receives a JSON-RPC response
   * with the matching id. Throws if a timeout occurs or an error response arrives.
   *
   * Returns the full JSON-RPC response object.
   */
  private _awaitResponse(
    proc: ChildProcess,
    expectedId: number,
    method: string,
    timeoutMs = CLI_TIMEOUT_MS,
  ): Promise<{ id: number; result?: Record<string, any>; error?: any }> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(
            `CodexAdapter: timed out waiting for JSON-RPC response id=${expectedId} (${method})`
          ));
        }
      }, timeoutMs);

      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue; // ignore non-JSON lines during handshake
          }

          if ('id' in parsed && parsed.id === expectedId) {
            settled = true;
            cleanup();

            if (parsed.error) {
              reject(new Error(
                `CodexAdapter: JSON-RPC error for id=${expectedId} (${method}): ` +
                `${parsed.error.message} (code ${parsed.error.code})`
              ));
            } else {
              resolve(parsed);
            }
            return;
          }
        }
      };

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`CodexAdapter: process error during handshake: ${err.message}`));
        }
      };

      const onClose = (code: number | null) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(
            `CodexAdapter: process closed (code=${code}) before response id=${expectedId}`
          ));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        proc.stdout?.removeListener('data', onData);
        proc.removeListener('error', onError);
        proc.removeListener('close', onClose);
      };

      proc.stdout?.on('data', onData);
      proc.once('error', onError);
      proc.once('close', onClose);
    });
  }

  // ---------------------------------------------------------------------------
  // Private: Title generation via codex exec
  // ---------------------------------------------------------------------------

  /**
   * Spawns `codex exec --json` with the conversation prompt and reads stdout
   * for the final agent_message item. The title prompt asks for a single JSON
   * object, which is parsed into a GeneratedTitle.
   *
   * Falls back to null if no valid title payload arrives within the timeout.
   */
  private async _generateTitleViaExec(
    prompt: string,
    userId?: string,
  ): Promise<GeneratedTitle | null> {
    const agentEnv = await getAgentEnvironment(userId);
    const command = await resolveProviderCliCommand(PROVIDER_ID, DEFAULT_COMMAND, agentEnv, userId);

    return new Promise((resolve, reject) => {
      const child = spawnCli(
        command,
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '-c',
          `model_reasoning_effort="${TITLE_REASONING_EFFORT}"`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: getRuntimePlatform() === 'win32' ? process.env.TEMP || process.cwd() : '/tmp',
          env: process.env as NodeJS.ProcessEnv,
        },
        agentEnv,
      );

      let buffer = '';
      let stderr = '';
      let settled = false;
      let titleFound: GeneratedTitle | null = null;
      let lastAgentText = '';

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          resolve(titleFound);
        }
      }, CLI_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (
            parsed?.type === 'item.completed' &&
            parsed.item?.type === 'agent_message' &&
            typeof parsed.item?.text === 'string'
          ) {
            lastAgentText = parsed.item.text;
            const parsedTitle = this._parseGeneratedTitleText(parsed.item.text);
            if (parsedTitle) {
              titleFound = parsedTitle;
              logger.info('CodexAdapter: generateTitle parsed agent_message', parsedTitle);
            }
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`CodexAdapter: failed to spawn codex exec: ${err.message}`));
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        logger.debug('CodexAdapter: codex exec closed', {
          code,
          stderrLength: stderr.length,
          titleFound: !!titleFound,
        });

        if (!titleFound && code !== 0) {
          reject(new Error(`codex exec exited with code ${code}: ${stderr.slice(0, 200)}`));
          return;
        }

        if (!titleFound && lastAgentText) {
          reject(new Error(`Invalid Codex title payload: ${lastAgentText.slice(0, 300)}`));
          return;
        }

        resolve(titleFound);
      });

      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }

  private _parseGeneratedTitleText(text: string): GeneratedTitle | null {
    const trimmed = text.trim();

    try {
      const direct = JSON.parse(trimmed);
      if (typeof direct?.title === 'string') {
        return {
          title: direct.title.slice(0, 100),
        };
      }
    } catch {
      // Fall through to regex extraction for slightly noisy responses.
    }

    const jsonMatch = trimmed.match(/"title"\s*:\s*"([^"]+)"/);
    if (!jsonMatch) return null;

    const [, title] = jsonMatch;

    return {
      title: title.slice(0, 100),
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const codexAdapter = new CodexAdapter();
