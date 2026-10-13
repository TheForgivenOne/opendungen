import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./retry";
import { AbortError, ProviderError } from "./types";

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("withRetry", () => {
  it("retries once on 429, then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new ProviderError("rate_limit", "limited", 429);
        }
        return "ok";
      },
      { maxRetries: 1, signal: new AbortController().signal },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("throws after the second attempt on repeated 500s", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError("unknown", "boom", 500);
        },
        { maxRetries: 1, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "unknown" });
    expect(calls).toBe(2);
  });

  it("does not retry on 400", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError("auth", "bad key", 401);
        },
        { maxRetries: 1, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "auth" });
    expect(calls).toBe(1);
  });

  it("does not retry network errors (the SDKs retry those themselves)", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError("network", "fetch failed");
        },
        { maxRetries: 1, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "network" });
    expect(calls).toBe(1);
  });

  it("aborts during the retry delay with an AbortError", async () => {
    const controller = new AbortController();
    const pending = withRetry(
      async () => {
        throw new ProviderError("rate_limit", "limited", 429);
      },
      { maxRetries: 1, signal: controller.signal },
    );
    // Fire the abort mid-delay (the delay is 1s + jitter).
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it("throws immediately when the signal is already aborted", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return "ok";
        },
        { maxRetries: 1, signal: abortedSignal() },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(0);
  });

  it("does not sleep with fake timers unadvanced (sanity: delay is ~1s)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const pending = withRetry(
        async () => {
          calls++;
          if (calls === 1) {
            throw new ProviderError("unknown", "boom", 503);
          }
          return "recovered";
        },
        { maxRetries: 1, signal: new AbortController().signal },
      );
      const assertion = expect(pending).resolves.toBe("recovered");
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
