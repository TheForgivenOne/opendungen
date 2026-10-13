import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startNodeServer, type NodeServerOptions } from "./node";
import type { ServerType } from "@hono/node-server";

let server: ServerType | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
  }
});

function baseUrl(): string {
  const address = server?.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("server has no address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function options(): NodeServerOptions {
  return {
    port: 0,
    authMode: "single",
    sessionSecret: "node-test-secret-not-for-production",
    dbPath: ":memory:",
    runMigrations: true,
    quiet: true,
  };
}

describe("node entry point", () => {
  it("serves /api/health over real HTTP", async () => {
    server = startNodeServer(options());
    // serve() binds asynchronously; poll briefly.
    let health: { ok: boolean; service: string; version: string } | null = null;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${baseUrl()}/api/health`);
        if (res.status === 200) {
          health = (await res.json()) as typeof health;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(health).toMatchObject({ ok: true, service: "opendungen", version: "0.0.0" });
  });

  it("reports ready when the database answers", async () => {
    server = startNodeServer(options());
    let status = 0;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${baseUrl()}/api/health/ready`);
        status = res.status;
        if (status === 200) {
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(status).toBe(200);
  });
});
