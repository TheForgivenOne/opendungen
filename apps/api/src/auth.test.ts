import { describe, expect, it } from "vitest";
import { createTestApp, sessionCookie, setupAdmin } from "./testing";

const PASSWORD = "correct-horse-battery-staple";

async function json(
  app: ReturnType<typeof import("./app").createApp>,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie) {
    headers["cookie"] = cookie;
  }
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("auth", () => {
  it("reports needsSetup before the first admin exists", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/auth/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "single",
      needsSetup: true,
      authenticated: false,
    });
  });

  it("setup creates the first admin and logs them in", async () => {
    const { app } = createTestApp();
    const res = await json(app, "POST", "/api/auth/setup", {
      email: "admin@example.com",
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string; email: string; instanceAdmin: boolean };
    };
    expect(body.user.email).toBe("admin@example.com");
    expect(body.user.instanceAdmin).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("opendungen_session=");

    const state = await app.request("/api/auth/state", {
      headers: { cookie: sessionCookie(res) },
    });
    expect(await state.json()).toEqual({
      mode: "single",
      needsSetup: false,
      authenticated: true,
    });
  });

  it("rejects a second setup with 409", async () => {
    const { app } = createTestApp();
    await setupAdmin(app);
    const res = await json(app, "POST", "/api/auth/setup", {
      email: "second@example.com",
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "already_setup", message: "an admin user already exists" },
    });
  });

  it("rejects invalid setup bodies with 400", async () => {
    const { app } = createTestApp();
    const res = await json(app, "POST", "/api/auth/setup", {
      email: "not-an-email",
      password: "short",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("login/logout round-trip with session cookie validation", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const me = await app.request("/api/auth/me", {
      headers: { cookie },
    });
    expect(me.status).toBe(200);

    const anon = await app.request("/api/auth/me");
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({
      error: { code: "unauthorized", message: "authentication required" },
    });

    const bad = await json(app, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: "wrong-password-here",
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_credentials" },
    });

    const login = await json(app, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    const freshCookie = sessionCookie(login);

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: freshCookie },
    });
    expect(logout.status).toBe(200);

    const after = await app.request("/api/auth/me", {
      headers: { cookie: freshCookie },
    });
    expect(after.status).toBe(401);
  });

  it("AUTH_MODE=none bypasses auth entirely", async () => {
    const { app } = createTestApp("none");
    const state = await app.request("/api/auth/state");
    expect(await state.json()).toEqual({
      mode: "none",
      needsSetup: false,
      authenticated: true,
    });
    const stories = await app.request("/api/stories");
    expect(stories.status).toBe(200);
    expect(await stories.json()).toEqual({ stories: [] });
  });

  it("AUTH_MODE=multi responds 501 on API routes but keeps health", async () => {
    const { app } = createTestApp("multi");
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    for (const path of ["/api/auth/state", "/api/stories"]) {
      const res = await app.request(path);
      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({
        error: {
          code: "not_implemented",
          message: 'auth mode "multi" is not implemented',
        },
      });
    }
  });
});
