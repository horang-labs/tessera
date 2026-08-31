const DEFAULT_TIMEOUT_MS = 3_000;

export function isTimeoutError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

function timeoutError(timeoutSignal: AbortSignal, error: unknown): DOMException {
  if (isTimeoutError(timeoutSignal.reason)) return timeoutSignal.reason;
  if (isTimeoutError(error)) return error;
  return new DOMException("The operation timed out.", "TimeoutError");
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

export interface FetchJsonWithTimeoutResult<T> {
  payload: T | null;
  response: Response;
}

/**
 * Keep the deadline active until the JSON body has arrived. `fetch()` resolves
 * after response headers, so wrapping only that promise leaves a slow body
 * outside the retry boundary.
 */
export async function fetchJsonWithTimeout<T>(
  input: RequestInfo | URL,
  init?: FetchWithTimeoutInit,
): Promise<FetchJsonWithTimeoutResult<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0, signal, ...rest } = init ?? {};

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(input, {
        ...rest,
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      const payload = await response.json().catch((error: unknown) => {
        if (signal?.aborted || timeoutSignal.aborted) throw error;
        return null;
      }) as T | null;
      return { payload, response };
    } catch (error) {
      if (signal?.aborted || !timeoutSignal.aborted) throw error;
      lastError = timeoutError(timeoutSignal, error);
    }
  }
  throw lastError;
}
