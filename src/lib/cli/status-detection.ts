import type { ExecResult } from './cli-exec';
import type {
  CliCommandSource,
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

function getProbeFailureKind(result: ExecResult): CliProbeFailureKind {
  if (result.ok) return 'ok';
  if (result.timedOut) return 'timeout';
  if (result.spawnErrorCode) return 'spawn_error';
  if (result.exitCode !== null) return 'nonzero_exit';
  return 'unknown';
}
