// Per-test-file servers: a stub LLM, a real API (Node entry point,
// temp SQLite file, migrations on boot), and the built web bundle
// served statically with /api proxied to the API (same-origin, with
// the Origin rewrite the API's CSRF check requires — mirroring the
// Vite dev proxy).
//
// The API runs from TypeScript source through the workspace tsx
// (apps/api/src/node.ts exports startNodeServer, but spawning the
// entry keeps the server in its own process exactly like `pnpm
// start`, without requiring a build:node step in CI).

import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { StubProvider } from "./stub-provider.js";

// pnpm/npm scripts always run with cwd = the workspace root, and
// Playwright never changes it — so the repo root is process.cwd().
// (Avoids __dirname / import.meta, which depend on how the runner
// loads TS files.)
const REPO_ROOT = process.cwd();
const API_DIR = join(REPO_ROOT, "apps", "api");
const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("could not allocate a port"));
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        return;
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`API never became ready at ${url} (last: ${lastError})`);
}

interface ApiProcess {
  proc: ChildProcess;
  port: number;
  stop: () => Promise<void>;
}

async function startApi(dbPath: string): Promise<ApiProcess> {
  // The .bin/tsx shim is a shell script — invoke the real CLI entry
  // with node directly.
  const tsxCli = join(API_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  try {
    await stat(tsxCli);
  } catch {
    throw new Error(`tsx not found at ${tsxCli} — run pnpm install first`);
  }
  const port = await freePort();
  const proc = spawn(process.execPath, [tsxCli, join(API_DIR, "src", "node.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      SESSION_SECRET: "e2e-test-secret-not-for-production-use",
      AUTH_MODE: "single",
      RUN_MIGRATIONS_ON_BOOT: "true",
      RATE_LIMIT_ENABLED: "false",
      // The stub LLM lives on 127.0.0.1; without this the SSRF
      // gate rejects every test provider. Test-harness config
      // only — the app default stays deny.
      ALLOW_PRIVATE_PROVIDER_URLS: "true",
      INSTANCE_SCRIPTS_ENABLED: "false",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
    if (stderr.length > 50) {
      stderr.shift();
    }
  });
  try {
    await waitForReady(`http://127.0.0.1:${port}/api/health/ready`, 90000);
  } catch (err) {
    proc.kill("SIGKILL");
    throw new Error(`${String(err)}\nAPI stderr:\n${stderr.join("")}`);
  }
  const stop = async (): Promise<void> => {
    proc.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 10000);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolvePromise(true);
      });
    });
    if (!exited) {
      proc.kill("SIGKILL");
    }
  };
  return { proc, port, stop };
}

function proxyToApi(req: IncomingMessage, res: ServerResponse, apiPort: number): void {
  const proxy = httpRequest(
    {
      host: "127.0.0.1",
      port: apiPort,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${apiPort}`,
        // Present the proxied request as same-origin to the API
        // (same rewrite the Vite dev proxy performs for CSRF).
        origin: `http://127.0.0.1:${apiPort}`,
      },
    },
    (apiRes) => {
      res.writeHead(apiRes.statusCode ?? 502, apiRes.headers);
      apiRes.pipe(res);
    },
  );
  proxy.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { code: "bad_gateway", message: "api proxy failed" } }));
  });
  req.pipe(proxy);
}

async function serveWebFile(
  res: ServerResponse,
  pathname: string,
  fallback: string,
): Promise<void> {
  let file = join(WEB_DIST, pathname);
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, "index.html");
      await stat(file);
    }
  } catch {
    file = fallback;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function startWeb(apiPort: number): Promise<{ server: HttpServer; port: number }> {
  try {
    await stat(join(WEB_DIST, "index.html"));
  } catch {
    throw new Error(`web bundle missing at ${WEB_DIST} — run pnpm -r build first`);
  }
  const fallback = join(WEB_DIST, "index.html");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      proxyToApi(req, res, apiPort);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    void serveWebFile(res, pathname, fallback);
  });
  const port = await freePort();
  await new Promise<void>((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
  return { server, port };
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((err) => (err ? reject(err) : resolvePromise()));
  });
}

export interface FileServers {
  apiUrl: string;
  webUrl: string;
  stub: StubProvider;
  close: () => Promise<void>;
}

export async function startFileServers(): Promise<FileServers> {
  const dir = await mkdtemp(join(tmpdir(), "opendungen-e2e-"));
  const stub = new StubProvider();
  let api: ApiProcess | null = null;
  let web: { server: HttpServer; port: number } | null = null;
  try {
    await stub.start();
    api = await startApi(join(dir, "test.db"));
    web = await startWeb(api.port);
  } catch (err) {
    if (web) {
      await closeHttp(web.server).catch(() => undefined);
    }
    if (api) {
      await api.stop().catch(() => undefined);
    }
    await stub.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    apiUrl: `http://127.0.0.1:${api.port}`,
    webUrl: `http://127.0.0.1:${web.port}`,
    stub,
    close: async () => {
      if (web) {
        await closeHttp(web.server).catch(() => undefined);
      }
      if (api) {
        await api.stop().catch(() => undefined);
      }
      await stub.stop().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
