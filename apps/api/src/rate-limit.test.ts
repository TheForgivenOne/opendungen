import { describe, expect, it } from "vitest";
import { RATE_LIMITS } from "./rate-limit";
import type { createApp } from "./app";
import { createTestApp, setupAdmin } from "./testing";

type App = ReturnType<typeof createApp>;

async function login(app: App, password = "correct-horse-battery-staple") {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password }),
  });
}

describe("rate limiting", () => {
  it("covers exactly the expensive endpoints with the specified budgets", () => {
    expect(RATE_LIMITS).toEqual({
      "POST /api/stories/:id/generate": 60,
      "POST /api/stories/:id/retry": 60,
      "POST /api/providers/:id/test": 20,
      "POST /api/import": 10,
      "POST /api/auth/login": 10,
      "POST /api/auth/setup": 5,
    });
  });

  it("passes requests under the limit", async () => {
    const { app } = createTestApp();
    await setupAdmin(app);
    for (let i = 0; i < 3; i++) {
      const res = await login(app);
      expect(res.status).toBe(200);
    }
  });

  it("rejects the 11th login in a minute with 429 + Retry-After", async () => {
    const { app } = createTestApp();
    await setupAdmin(app);
    for (let i = 0; i < 10; i++) {
      const res = await login(app);
      expect(res.status).toBe(200);
    }
    const limited = await login(app);
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("keys anonymous attempts by IP, not by account", async () => {
    const { app } = createTestApp();
    // No sessions exist yet: 10 bad-password attempts from the same
    // (implicit) IP exhaust the shared anonymous bucket...
    for (let i = 0; i < 10; i++) {
      await login(app, "wrong-password");
    }
    const limited = await login(app, "wrong-password");
    expect(limited.status).toBe(429);
    // ...while a different client IP gets its own bucket.
    const other = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "203.0.113.7",
      },
      body: JSON.stringify({ email: "admin@example.com", password: "wrong-password" }),
    });
    expect(other.status).toBe(401);
  });

  it("RATE_LIMIT_ENABLED=false bypasses all limits", async () => {
    const { app } = createTestApp("single", { env: { rateLimitEnabled: false } });
    await setupAdmin(app);
    for (let i = 0; i < 11; i++) {
      const res = await login(app);
      expect(res.status).toBe(200);
    }
  });
});
