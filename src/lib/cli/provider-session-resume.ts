import type { ProviderHomeIdentity } from './providers/provider-home-identity';

export type ProviderSessionResumeUnavailableReason =
  | 'origin-home-not-authoritative'
  | 'provider-history-missing'
  | 'provider-session-already-running';

export class ProviderSessionResumeUnavailableError extends Error {
  readonly code = 'session_resume_unavailable';

  constructor(
    readonly reason: ProviderSessionResumeUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderSessionResumeUnavailableError';
  }
}

export function isProviderSessionResumeUnavailableError(
  error: unknown,
): error is ProviderSessionResumeUnavailableError {
  return error instanceof ProviderSessionResumeUnavailableError;
}

export function assertProviderHomeAuthority(
  requiredIdentity: ProviderHomeIdentity | undefined,
  actualIdentity: ProviderHomeIdentity | undefined,
): void {
  if (requiredIdentity && actualIdentity !== requiredIdentity) {
    throw new ProviderSessionResumeUnavailableError(
      'origin-home-not-authoritative',
      'This managed session belongs to a different provider home. Switch back to its origin Agent Environment to resume it.',
    );
  }
}
