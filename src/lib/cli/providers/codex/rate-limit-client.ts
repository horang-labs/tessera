import { buildCodexRateLimitSnapshot } from '@/lib/status-display/rate-limit-snapshots';
import type { ProviderRateLimitsSnapshot } from '@/lib/status-display/types';
import type { CliEnvironment } from '@/lib/cli/cli-exec';
import { executeCodexAppServerRequest } from './app-server-request-client';

type CodexRateLimits = Parameters<typeof buildCodexRateLimitSnapshot>[0];

interface CodexRateLimitReadResult {
  rateLimits?: CodexRateLimits;
  rateLimitsByLimitId?: Record<string, CodexRateLimits | undefined>;
}

/**
 * Read account-wide Codex limits through a short-lived app-server process.
 * This deliberately has no Tessera session dependency.
 */
export async function fetchCodexRateLimitSnapshot(
  environment: CliEnvironment,
): Promise<ProviderRateLimitsSnapshot | null> {
  const result = await executeCodexAppServerRequest<CodexRateLimitReadResult>(
    { environment },
    'account/rateLimits/read',
    {},
  );
  const rateLimits = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  return rateLimits ? buildCodexRateLimitSnapshot(rateLimits) : null;
}
