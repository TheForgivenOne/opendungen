// Transient-failure retry for provider calls. Retries exactly once
// (maxRetries: 1) on 429 and 5xx only — never on other 4xx, on abort,
// or on network errors (already retried by the underlying SDKs).
// Callers must not retry after the first chunk has been emitted to the
// client: once streaming starts, a restart would discard visible text,
// so only the pre-stream acquisition is wrapped.

import { AbortError, ProviderError } from "./types";

export interface RetryOptions {
  maxRetries: number;
  signal: AbortSignal;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.status === undefined) {
    return false;
  }
  return err.status === 429 || (err.status >= 500 && err.status <= 599);
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return (
    err instanceof AbortError ||
    signal.aborted ||
    (err instanceof Error &&
      (err.name === "AbortError" || err.message.toLowerCase().includes("aborted")))
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new AbortError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = 1 + Math.max(0, opts.maxRetries);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal.aborted) {
      throw new AbortError();
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isAbort(err, opts.signal)) {
        throw err;
      }
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw err;
      }
      // 1s + up to 500ms jitter. An abort during the wait rejects
      // immediately with an AbortError.
      await delay(1000 + Math.random() * 500, opts.signal);
    }
  }
  throw lastError;
}
