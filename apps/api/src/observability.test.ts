import { afterEach, describe, expect, it, vi } from "vitest";
import { setLogLevel } from "./log";
import { createTestApp, setupAdmin } from "./testing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line !== null);
}

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel(undefined);
});

describe("request IDs", () => {
  it("echoes an incoming X-Request-Id", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/health", {
      headers: { "X-Request-Id": "test-request-123" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("test-request-123");
  });

  it("generates a UUID when none is sent", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/health");
    const echoed = res.headers.get("x-request-id") ?? "";
    expect(echoed).toMatch(UUID_RE);
  });

  it("includes the request id in error responses", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const res = await app.request("/api/stories/does-not-exist", {
      headers: { cookie, "X-Request-Id": "err-id-1" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe("err-id-1");
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBe("err-id-1");
  });
});

describe("request logging", () => {
  it("emits one JSON line per request with method/path/status/requestId", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app } = createTestApp();
    await app.request("/api/health", { headers: { "X-Request-Id": "log-id-9" } });
    const requestLines = lines(spy).filter((line) => line.msg === "request");
    expect(requestLines.length).toBe(1);
    expect(requestLines[0]).toMatchObject({
      level: "info",
      msg: "request",
      method: "GET",
      path: "/api/health",
      status: 200,
      requestId: "log-id-9",
    });
    expect(typeof requestLines[0].ts).toBe("number");
    expect(typeof requestLines[0].durationMs).toBe("number");
  });

  it("tags authenticated requests with the user id, never the query string", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app } = createTestApp();
    const { cookie, userId } = await setupAdmin(app);
    await app.request("/api/export/all?includeKeys=true", { headers: { cookie } });
    const requestLines = lines(spy).filter((line) => line.msg === "request");
    const exportLine = requestLines.find((line) => line.path === "/api/export/all");
    expect(exportLine).toMatchObject({ userId });
    expect(JSON.stringify(exportLine)).not.toContain("includeKeys");
  });
});

describe("log levels", () => {
  it("emits debug lines only with LOG_LEVEL=debug", async () => {
    const { log } = await import("./log");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    setLogLevel("info");
    log.debug("hidden");
    expect(lines(spy).length).toBe(0);
    setLogLevel("debug");
    log.debug("shown");
    expect(lines(spy)).toMatchObject([{ level: "debug", msg: "shown" }]);
  });
});
