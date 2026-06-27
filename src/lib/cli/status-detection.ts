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
  if (result.spawnErrorCode === 'EACCES' || result.spawnErrorCode === 'EPERM') {
    return 'permission_denied';
  }
  if (
    result.spawnErrorCode === 'ENOENT'
    || result.spawnErrorCode === 'ENOEXEC'
  ) {
    return 'binary_missing';
  }
  if (result.timedOut) return 'version_timeout';
  if (result.exitCode !== null) return 'version_nonzero';
  return 'unknown';
}

/**
 * Treats a `--version` probe as "binary exists and ran" unless we have hard
 * evidence the binary can't be invoked. Matches paseo's classifyProbeError:
 * ENOENT/ENOEXEC/EACCES/EPERM are real failures; timeouts and non-zero exits
 * still prove the file was launched (CLIs that print to stderr-then-exit-1, or
 * boot slowly, are common).
 */
export function isVersionProbeRunnable(result: ExecResult): boolean {
  if (result.ok) return true;
  const code = result.spawnErrorCode;
  if (code === 'ENOENT' || code === 'ENOEXEC' || code === 'EACCES' || code === 'EPERM') {
    return false;
  }
  return true;
}

/**
 * Combines a runnable version probe with the auth-probe verdict. Once the
 * version probe proves the binary launched, an inconclusive auth probe (timeout
 * or spawn error) must not regress the install signal back to `not_installed` —
 * that's the exact false-alarm class the user reported. A non-zero exit from
 * auth still maps to `needs_login` because the binary is actively telling us
 * it isn't authenticated.
 */
export function synthesizeRunnableStatus(
  versionResult: ExecResult,
  authVerdict: { status: CliConnectionStatus; detectionReason: CliDetectionReason },
): { status: CliConnectionStatus; detectionReason: CliDetectionReason } {
  if (!isVersionProbeRunnable(versionResult)) {
    return authVerdict;
  }
  if (authVerdict.status === 'not_installed') {
    return { status: 'connected', detectionReason: authVerdict.detectionReason };
  }
  return authVerdict;
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
  // A runnable probe (success, timeout, or non-zero exit) proves the binary
  // exists — OpenCode never gates on login, so that's all we need. Only a real
  // spawn failure (ENOENT/ENOEXEC/EACCES/EPERM) is "not installed".
  if (isVersionProbeRunnable(versionResult)) {
    return { status: 'connected', detectionReason: 'connected' };
  }
  return {
    status: 'not_installed',
    detectionReason: classifyVersionFailure(versionResult, commandSource),
  };
}

function getProbeFailureKind(result: ExecResult): CliProbeFailureKind {
  if (result.ok) return 'ok';
  if (result.timedOut) return 'timeout';
  if (result.spawnErrorCode) return 'spawn_error';
  if (result.exitCode !== null) return 'nonzero_exit';
  return 'unknown';
}
