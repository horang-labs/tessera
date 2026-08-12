import logger from '@/lib/logger';
import {
  ProviderLaunchError,
  type ProviderLaunchErrorCode,
} from '@/lib/terminal/provider-launch-module';
import {
  ControlSessionStartError,
  type ControlErrorCode,
} from './service';

interface PublicLaunchFailure {
  code: ControlErrorCode;
  message: string;
  httpStatus: number;
}

const PUBLIC_LAUNCH_FAILURES: Record<ProviderLaunchErrorCode, PublicLaunchFailure> = {
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    message: 'The requested Session does not exist.',
    httpStatus: 404,
  },
  SESSION_NOT_TERMINAL: {
    code: 'SESSION_NOT_FOUND',
    message: 'The requested Session does not exist.',
    httpStatus: 404,
  },
  SESSION_PROVIDER_MISMATCH: {
    code: 'INSTANCE_UNAVAILABLE',
    message: 'The Session runtime could not be started.',
    httpStatus: 500,
  },
  SESSION_WORKSPACE_UNAVAILABLE: {
    code: 'INSTANCE_UNAVAILABLE',
    message: 'The Session runtime could not be started.',
    httpStatus: 500,
  },
  SESSION_RUNTIME_ALREADY_RUNNING: {
    code: 'SESSION_RUNTIME_ALREADY_RUNNING',
    message: 'The Session already has a live PTY runtime.',
    httpStatus: 409,
  },
  SESSION_NOT_FRESH: {
    code: 'SESSION_NOT_FRESH',
    message: 'An initial prompt is allowed only for a fresh provider conversation.',
    httpStatus: 409,
  },
  PROVIDER_NOT_SUPPORTED: {
    code: 'PROVIDER_NOT_SUPPORTED',
    message: 'The Session provider is not supported for PTY launch.',
    httpStatus: 400,
  },
  INITIAL_PROMPT_EMPTY: {
    code: 'INVALID_USAGE',
    message: 'The initial prompt must contain non-whitespace text.',
    httpStatus: 400,
  },
  INITIAL_PROMPT_TOO_LARGE: {
    code: 'INITIAL_PROMPT_TOO_LARGE',
    message: 'The initial prompt exceeds the supported UTF-8 byte limit.',
    httpStatus: 400,
  },
  PREPARATION_FAILED: {
    code: 'PREPARATION_FAILED',
    message: 'Worktree preparation failed before an agent could start.',
    httpStatus: 409,
  },
  PREPARATION_TIMEOUT: {
    code: 'PREPARATION_TIMEOUT',
    message: 'Worktree preparation did not finish before the timeout.',
    httpStatus: 504,
  },
  SESSION_RESUME_UNAVAILABLE: {
    code: 'INSTANCE_UNAVAILABLE',
    message: 'The managed provider conversation is unavailable in the current Agent Environment.',
    httpStatus: 409,
  },
  LAUNCH_FAILED: {
    code: 'INSTANCE_UNAVAILABLE',
    message: 'The Session runtime could not be started.',
    httpStatus: 500,
  },
};

export function toControlLaunchError(
  error: unknown,
  sessionId: string,
): ControlSessionStartError {
  logger.error({
    code: error instanceof ProviderLaunchError ? error.code : 'UNKNOWN',
    runtimeState: error instanceof ProviderLaunchError ? error.runtimeState : 'unowned',
    sessionId,
  }, 'Control Session launch failed');

  if (!(error instanceof ProviderLaunchError)) {
    return new ControlSessionStartError(
      'INSTANCE_UNAVAILABLE',
      'The Session runtime could not be started.',
      500,
      { sessionId },
      'unowned',
    );
  }

  const failure = PUBLIC_LAUNCH_FAILURES[error.code];
  const details = failure.code === 'SESSION_RUNTIME_ALREADY_RUNNING' && error.terminalId
    ? { sessionId, terminalId: error.terminalId }
    : { sessionId };
  return new ControlSessionStartError(
    failure.code,
    failure.message,
    failure.httpStatus,
    details,
    error.runtimeState,
  );
}
