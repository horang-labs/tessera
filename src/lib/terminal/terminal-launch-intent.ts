import { resolveProviderCliCommand } from '@/lib/cli/provider-command';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { processManager } from '@/lib/cli/process-manager';
import {
  classifyCodexSlashCommand,
  isCodexSlashCommandAvailable,
} from '@/lib/chat/codex-slash-command-registry';
import { getProject } from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import { sessionHistory } from '@/lib/session-history';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { CODEX_THREAD_ID_RE } from '@/lib/validation/path';
import {
  acquireTerminalHandoffLock,
  releaseTerminalHandoffByTerminal,
} from './terminal-handoff-lock';
import type { TerminalLaunchIntent, TerminalLaunchSpec } from './types';

const MAX_COMMAND_INPUT_LENGTH = 4_000;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/g;

export class TerminalLaunchIntentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'TerminalLaunchIntentError';
  }
}

function normalizeCommandInput(commandInput: string): string {
  if (commandInput.length > MAX_COMMAND_INPUT_LENGTH) {
    throw new TerminalLaunchIntentError(
      `Terminal command is too long (maximum ${MAX_COMMAND_INPUT_LENGTH} characters).`,
      'command_too_long',
    );
  }
  const normalized = commandInput
    .replace(CONTROL_CHAR_RE, ' ')
    .trim();
  if (!normalized.startsWith('/')) {
    throw new TerminalLaunchIntentError('Terminal fallback requires a slash command.', 'invalid_command');
  }
  return normalized;
}

function readCodexThreadId(sessionId: string): string {
  const session = dbSessions.getSession(sessionId);
  if (!session) {
    throw new TerminalLaunchIntentError('Session does not exist.', 'session_not_found');
  }
  if (session.provider !== 'codex') {
    throw new TerminalLaunchIntentError('This terminal route requires a Codex session.', 'provider_mismatch');
  }
  const threadId = dbSessions.extractThreadId(session.provider_state);
  if (!threadId || !CODEX_THREAD_ID_RE.test(threadId)) {
    throw new TerminalLaunchIntentError('This Codex session has no resumable thread.', 'thread_unavailable');
  }
  return threadId;
}

function readSessionLaunchCwd(sessionId: string): string | undefined {
  const session = dbSessions.getSession(sessionId);
  const workDir = session?.work_dir?.trim();
  if (workDir) return workDir;
  const projectDir = session?.project_id
    ? getProject(session.project_id)?.decoded_path?.trim()
    : undefined;
  return projectDir || undefined;
}

async function assertHandoffIdle(sessionId: string): Promise<void> {
  const processInfo = processManager.getProcess(sessionId);
  if (processInfo?.isGenerating) {
    throw new TerminalLaunchIntentError(
      'Wait for the current Codex turn to finish before opening a handoff terminal.',
      'session_busy',
    );
  }
  if ((processInfo?.pendingPermissionRequests?.size ?? 0) > 0) {
    throw new TerminalLaunchIntentError(
      'Answer the pending Codex prompt before opening a handoff terminal.',
      'interactive_prompt_pending',
    );
  }
  try {
    const replay = await sessionHistory.readReplayState(sessionId, { lazyToolOutput: true });
    if (replay.activeInteractivePrompt) {
      throw new TerminalLaunchIntentError(
        'Answer the pending Codex prompt before opening a handoff terminal.',
        'interactive_prompt_pending',
      );
    }
  } catch (error) {
    if (error instanceof TerminalLaunchIntentError) throw error;
    throw new TerminalLaunchIntentError(
      'Tessera could not verify that this Codex session is idle.',
      'handoff_state_unavailable',
    );
  }
}

async function acquireTerminalSessionLease(options: {
  sessionId: string;
  terminalId: string;
  userId: string;
}): Promise<void> {
  if (!acquireTerminalHandoffLock(options)) {
    throw new TerminalLaunchIntentError(
      'This Codex session is busy or already open in a terminal.',
      'handoff_locked',
    );
  }
  try {
    await assertHandoffIdle(options.sessionId);
  } catch (error) {
    releaseTerminalHandoffByTerminal(options.userId, options.terminalId);
    throw error;
  }
}

export async function resolveTerminalLaunchIntent(options: {
  intent: TerminalLaunchIntent;
  sessionId?: string | null;
  terminalId: string;
  userId: string;
}): Promise<TerminalLaunchSpec> {
  if (
    !options.intent
    || (options.intent.kind !== 'claude-slash' && options.intent.kind !== 'codex-slash')
    || typeof options.intent.commandInput !== 'string'
  ) {
    throw new TerminalLaunchIntentError('Invalid terminal launch request.', 'invalid_intent');
  }
  const commandInput = normalizeCommandInput(options.intent.commandInput);
  const agentEnvironment = await getAgentEnvironment(options.userId);

  if (options.intent.kind === 'claude-slash') {
    const session = options.sessionId ? dbSessions.getSession(options.sessionId) : null;
    if (session?.provider !== 'claude-code') {
      throw new TerminalLaunchIntentError(
        'This terminal route requires a Claude Code session.',
        'provider_mismatch',
      );
    }
    return {
      program: await resolveProviderCliCommand('claude-code', 'claude', agentEnvironment, options.userId),
      args: [],
      prefillInput: commandInput,
      cwd: options.sessionId ? readSessionLaunchCwd(options.sessionId) : undefined,
    };
  }

  const match = classifyCodexSlashCommand(commandInput);
  if (!match || !match.support.startsWith('terminal-')) {
    throw new TerminalLaunchIntentError(
      'This Codex command is not available through the terminal fallback.',
      'command_not_terminal',
    );
  }
  if (!isCodexSlashCommandAvailable(match.canonicalName, {
    platform: getRuntimePlatform(),
    agentEnvironment,
  })) {
    throw new TerminalLaunchIntentError(
      'This Codex command is only available in a native Windows environment.',
      'platform_unavailable',
    );
  }
  if (match.args && match.terminalMode === 'resume-picker') {
    throw new TerminalLaunchIntentError(
      `/${match.name} does not accept arguments in Tessera's terminal route.`,
      'command_args_unsupported',
    );
  }
  if (!options.sessionId) {
    throw new TerminalLaunchIntentError('A Codex session is required.', 'session_required');
  }

  const session = dbSessions.getSession(options.sessionId);
  if (!session || session.provider !== 'codex') {
    throw new TerminalLaunchIntentError('This terminal route requires a Codex session.', 'provider_mismatch');
  }
  const program = await resolveProviderCliCommand('codex', 'codex', agentEnvironment, options.userId);
  const cwd = readSessionLaunchCwd(options.sessionId);

  if (match.terminalMode === 'resume-picker') {
    return {
      shellPrefillArgv: { program, args: ['resume'] },
      cwd,
    };
  }
  if (match.support === 'terminal-direct') {
    return { program, args: [], prefillInput: commandInput, cwd };
  }

  const threadId = readCodexThreadId(options.sessionId);
  await acquireTerminalSessionLease({
    sessionId: options.sessionId,
    terminalId: options.terminalId,
    userId: options.userId,
  });
  return {
    program,
    args: ['resume', threadId],
    prefillInput: commandInput,
    handoffSessionId: options.sessionId,
    cwd,
  };
}
