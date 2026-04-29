import type { ChildProcess } from 'child_process';
import logger from '../logger';
import { sessionHistory } from '../session-history';
import type { ParsedMessage } from './providers/types';
import type { ProcessInfo } from './types';

type ProcessMap = Map<string, ProcessInfo>;

interface RouteManagedProcessStdoutLineOptions {
  processes: ProcessMap;
  sessionId: string;
  userId: string;
  line: string;
  fallbackParseStdout: (sessionId: string, userId: string, line: string) => void;
  dispatchParsedMessages: (sessionId: string, userId: string, messages: ParsedMessage[]) => void;
}

interface AttachManagedProcessHandlersOptions {
  processes: ProcessMap;
  sessionId: string;
  userId: string;
  cliProcess: ChildProcess;
  routeStdoutLine: (sessionId: string, userId: string, line: string) => void;
  handleProcessExit: (
    sessionId: string,
    userId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  handleProcessError: (sessionId: string, error: Error) => void;
}

interface HandleManagedProcessExitOptions {
  processes: ProcessMap;
  sessionId: string;
  userId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  clearSessionRuntimeState: (sessionId: string) => void;
  dispatchParsedMessages: (sessionId: string, userId: string, messages: ParsedMessage[]) => void;
  fallbackHandleProcessExit: (sessionId: string, userId: string, exitCode: number) => void;
}

export function routeManagedProcessStdoutLine({
  processes,
  sessionId,
  userId,
  line,
  fallbackParseStdout,
  dispatchParsedMessages,
}: RouteManagedProcessStdoutLineOptions): void {
  if (!line.trim()) {
    return;
  }

  const provider = processes.get(sessionId)?.provider;
  if (!provider?.parseSessionStdout) {
    fallbackParseStdout(sessionId, userId, line);
    return;
  }

  try {
    const messages = provider.parseSessionStdout(sessionId, line);
    dispatchParsedMessages(sessionId, userId, messages);
  } catch (error) {
    logger.error('Provider message handling error', {
      sessionId,
      provider: provider.getDisplayName(),
      line: line.substring(0, 100),
      error: (error as Error).message,
    });
  }
}

export function attachManagedProcessHandlers({
  processes,
  sessionId,
  userId,
  cliProcess,
  routeStdoutLine,
  handleProcessExit,
  handleProcessError,
}: AttachManagedProcessHandlersOptions): void {
  let stdoutBuffer = '';

  cliProcess.stdout?.on('data', (chunk: Buffer) => {
    const info = processes.get(sessionId);
    if (info) {
      info.lastActivityAt = new Date();
    }

    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      routeStdoutLine(sessionId, userId, line);
    }
  });

  cliProcess.stderr?.on('data', (chunk: Buffer) => {
    logger.error({ sessionId, output: chunk.toString() }, 'CLI stderr');
  });

  cliProcess.on('exit', (code, signal) => {
    handleProcessExit(sessionId, userId, code, signal);
  });

  cliProcess.on('error', (error) => {
    handleProcessError(sessionId, error);
  });
}

export function handleManagedProcessExit({
  processes,
  sessionId,
  userId,
  code,
  signal,
  clearSessionRuntimeState,
  dispatchParsedMessages,
  fallbackHandleProcessExit,
}: HandleManagedProcessExitOptions): void {
  const info = processes.get(sessionId);
  const provider = info?.provider;
  const duration = info ? Date.now() - info.createdAt.getTime() : 0;
  const exitCode = code ?? -1;
  sessionHistory.flushSession(sessionId);

  logger.error({
    sessionId,
    userId,
    exitCode: code,
    signal,
    duration,
  }, 'CLI process exited');

  clearSessionRuntimeState(sessionId);

  if (provider?.handleSessionExit) {
    const messages = provider.handleSessionExit(sessionId, exitCode);
    if (exitCode !== 0) {
      dispatchParsedMessages(sessionId, userId, messages);
    }
    return;
  }

  if (exitCode !== 0) {
    fallbackHandleProcessExit(sessionId, userId, exitCode);
  }
}

export function handleManagedProcessError(
  sessionId: string,
  error: Error,
  clearSessionRuntimeState: (sessionId: string) => void,
): void {
  logger.error({ sessionId, error }, 'CLI process error');
  clearSessionRuntimeState(sessionId);
}

export function performManagedProcessHealthCheck(processes: ProcessMap): void {
  const startTime = Date.now();
  let checkedCount = 0;

  processes.forEach((info, sessionId) => {
    try {
      if (info.process.pid) {
        process.kill(info.process.pid, 0);
        checkedCount++;
      }
    } catch {
      logger.error({ sessionId, pid: info.process.pid }, 'Process not responding');
      info.status = 'error';
    }
  });

  const duration = Date.now() - startTime;

  logger.debug({
    duration,
    checkedCount,
    totalProcesses: processes.size,
  }, 'Health check completed');

  if (duration > 100) {
    logger.warn({ duration }, 'Health check slow');
  }
}
