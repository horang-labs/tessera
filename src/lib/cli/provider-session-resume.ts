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
