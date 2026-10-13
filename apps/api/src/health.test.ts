import { describe, expect, it } from "vitest";
import { createTestApp } from "./testing";

describe("GET /api/health", () => {
  it("returns the service status", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "opendungen", version: "0.1.0" });
  });

  it("reports readiness when the database answers", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
