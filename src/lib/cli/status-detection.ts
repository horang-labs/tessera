import type { ExecResult } from './cli-exec';
import type {
  CliCommandSource,
  CliConnectionStatus,
  CliDetectionReason,
  CliProbeFailureKind,
  CliProbeSummary,
} from './providers/provider-contract';

export function summarizeExecProbe(result: ExecResult): CliProbeSummary {
  return {
    ok: result.ok,
    failureKind: getProbeFailureKind(result),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    ...(result.spawnErrorCode ? { spawnErrorCode: result.spawnErrorCode } : {}),
  };
}

export function classifyVersionFailure(
  result: ExecResult,
  commandSource: CliCommandSource,
): CliDetectionReason {
  if (result.ok) return 'connected';
  if (commandSource === 'override') return 'override_failed';
  if (result.timedOut) return 'version_timeout';
  if (result.spawnErrorCode === 'EACCES' || result.spawnErrorCode === 'EPERM') {
    return 'permission_denied';
  }
  if (result.spawnErrorCode === 'ENOENT') return 'binary_missing';
  if (result.exitCode !== null) return 'version_nonzero';
  return 'unknown';
}

export function classifyAuthFailure(result: ExecResult): CliDetectionReason {
  if (result.ok) return 'connected';
  if (result.timedOut) return 'auth_timeout';
  return 'auth_failed';
}

export function classifyAuthStatus(result: ExecResult): {
  status: CliConnectionStatus;
  detectionReason: CliDetectionReason;
} {
  const detectionReason = classifyAuthFailure(result);
  if (result.ok) {
    return { status: 'connected', detectionReason };
  }
  if (!result.timedOut && result.exitCode !== null) {
    return { status: 'needs_login', detectionReason };
  }
  return { status: 'not_installed', detectionReason };
}

/**
 * Resolves OpenCode's connection status from the version probe alone.
 *
 * Unlike Claude Code (`auth status`) and Codex (`login status`), OpenCode has
 * no dedicated auth-status command and never gates on login: its free hosted
 * models are always available, so `opencode models` exits 0 even with zero
 * credentials. Probing `models` therefore measures OpenCode's ~2s runtime boot,
 * not auth — and on a slow boot it timed out and was mislabeled "needs_login".
 *
 * A runnable binary is "connected"; only a failed version probe is a problem.
 */
export function classifyOpenCodeStatus(
  versionResult: ExecResult,
  commandSource: CliCommandSource,
): { status: CliConnectionStatus; detectionReason: CliDetectionReason } {
  if (!versionResult.ok) {
    return {
      status: 'not_installed',
      detectionReason: classifyVersionFailure(versionResult, commandSource),
    };
  }
  return { status: 'connected', detectionReason: 'connected' };
}

function getProbeFailureKind(result: ExecResult): CliProbeFailureKind {
  if (result.ok) return 'ok';
  if (result.timedOut) return 'timeout';
  if (result.spawnErrorCode) return 'spawn_error';
  if (result.exitCode !== null) return 'nonzero_exit';
  return 'unknown';
}
