const DEFAULT_TIMEOUT_MS = 3_000;

export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

export interface FetchWithTimeoutInit extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: FetchWithTimeoutInit,
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0, signal, ...rest } = init ?? {};

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(input, {
        ...rest,
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      lastError = error;
      if (signal?.aborted || !isTimeoutError(error)) throw error;
    }
  }
  throw lastError;
}
