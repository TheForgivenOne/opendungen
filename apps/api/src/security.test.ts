import { describe, expect, it } from "vitest";
import type { createApp } from "./app";
import { createTestApp, setupAdmin } from "./testing";

type App = ReturnType<typeof createApp>;

async function authedApp(
  env?: Parameters<typeof createTestApp>[1],
): Promise<{ app: App; cookie: string }> {
  const { app } = createTestApp("single", env);
  const { cookie } = await setupAdmin(app);
  return { app, cookie };
}

describe("security headers", () => {
  it("sets the full header set on a normal response", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("serves the strict CSP in production", async () => {
    const { app } = createTestApp("single", { env: { isProduction: true } });
    const res = await app.request("/api/health");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain("127.0.0.1:5173");
  });
});

describe("CSRF origin check", () => {
  async function createStory(app: App, cookie: string, headers: Record<string, string> = {}) {
    return app.request("/api/stories", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...headers },
      body: JSON.stringify({ title: "CSRF probe" }),
    });
  }

  it("rejects mutating requests with a foreign Origin", async () => {
    const { app, cookie } = await authedApp();
    const res = await createStory(app, cookie, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects foreign Referer as a fallback signal", async () => {
    const { app, cookie } = await authedApp();
    const res = await createStory(app, cookie, {
      Referer: "https://evil.example/some/page",
    });
    expect(res.status).toBe(403);
  });

  it("allows same-origin and headerless requests", async () => {
    const { app, cookie } = await authedApp();
    // app.request uses http://localhost/ as the request origin.
    const same = await createStory(app, cookie, { Origin: "http://localhost" });
    expect(same.status).toBe(201);
    const bare = await createStory(app, cookie);
    expect(bare.status).toBe(201);
  });

  it("trusts CORS-listed origins (split deployments can mutate)", async () => {
    const { app, cookie } = await authedApp({
      env: { corsOrigins: ["https://app.example.com"] },
    });
    const res = await createStory(app, cookie, { Origin: "https://app.example.com" });
    expect(res.status).toBe(201);
    const foreign = await createStory(app, cookie, { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
  });

  it("exempts setup and login", async () => {
    const { app } = createTestApp();
    const setup = await app.request("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ email: "csrf@example.com", password: "correct-horse-battery-staple" }),
    });
    expect(setup.status).toBe(201);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ email: "csrf@example.com", password: "wrong-password" }),
    });
    // 401 proves the request passed CSRF and reached authentication.
    expect(login.status).toBe(401);
  });
});

describe("body size limits", () => {
  it("rejects JSON bodies over 1 MB with 413", async () => {
    const { app, cookie } = await authedApp();
    const res = await app.request("/api/stories", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: `x${"y".repeat(1_100_000)}` }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("rejects import bodies over 64 MB with 413", async () => {
    const { app, cookie } = await authedApp();
    const boundary = "----phase5boundary";
    const payload = "a".repeat(65_000_000);
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"big.json\"\r\n` +
      `Content-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
    const res = await app.request("/api/import?mode=merge", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie },
      body,
    });
    expect(res.status).toBe(413);
  });
});

describe("CORS", () => {
  it("sends no CORS headers by default (same-origin only)", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/health", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes allowed origins with credentials when configured", async () => {
    const { app } = createTestApp("single", {
      env: { corsOrigins: ["https://app.example.com"] },
    });
    const res = await app.request("/api/health", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    const authed = await app.request("/api/auth/state", {
      headers: { Origin: "https://other.example.com" },
    });
    expect(authed.headers.get("access-control-allow-origin")).toBeNull();
  });
});
