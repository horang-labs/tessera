import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchJsonWithTimeout,
  isTimeoutError,
} from "../src/lib/api/fetch-with-timeout";

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) {
      rejectAbort();
      return;
    }
    signal?.addEventListener("abort", rejectAbort, { once: true });
  });
}

test("fetchJsonWithTimeout never retries an external abort", async () => {
  const originalFetch = globalThis.fetch;
  const keepAlive = setInterval(() => undefined, 100);
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    return rejectWhenAborted(init?.signal);
  }) as typeof fetch;

  try {
    const request = fetchJsonWithTimeout("https://example.invalid", {
      signal: controller.signal,
      timeoutMs: 1_000,
      retries: 2,
    });
    controller.abort();
    await assert.rejects(request, (error: unknown) => (
      error instanceof DOMException && error.name === "AbortError"
    ));
    assert.equal(calls, 1);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
  }
});

test("fetchJsonWithTimeout retries when the response body misses the deadline", async () => {
  const originalFetch = globalThis.fetch;
  const keepAlive = setInterval(() => undefined, 100);
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    return new Response(new ReadableStream({
      start(controller) {
        const abort = () => controller.error(
          new DOMException("The operation was aborted.", "AbortError"),
        );
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      },
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      fetchJsonWithTimeout("https://example.invalid", { timeoutMs: 5, retries: 1 }),
      (error: unknown) => isTimeoutError(error),
    );
    assert.equal(calls, 2);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
  }
});
