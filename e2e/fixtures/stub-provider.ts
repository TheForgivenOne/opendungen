// In-process stub LLM server implementing the OpenAI-compatible
// /v1/chat/completions streaming protocol. Tests never touch real
// providers: every generation in E2E drains from here.
//
// Behavior is selected per request by the `X-Stub-Mode` header, or by
// the server-side default set with setMode() when the header is
// absent (providers store no custom headers, so tests flip modes
// without touching provider rows):
//   stream (default): 3 deterministic text chunks, a usage chunk,
//                     then [DONE].
//   empty:            200 with [DONE] immediately (no deltas).
//   error:            HTTP 500.
//   slow:             one chunk every 2 seconds (abort/keepalive).
// GET /v1/models answers a stable one-model listing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type StubMode = "stream" | "empty" | "error" | "slow";

const VALID_MODES: StubMode[] = ["stream", "empty", "error", "slow"];

export interface StubRequest {
  method: string;
  url: string;
  stubMode: StubMode;
  body: string;
}

const STREAM_DELTAS = ["This is a test ", "generation ", "response."];

function chunkPayload(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function usagePayload(): string {
  return JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 9 },
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

export class StubProvider {
  private server: Server | null = null;
  private defaultMode: StubMode = "stream";
  private portValue = 0;
  readonly requests: StubRequest[] = [];

  get port(): number {
    return this.portValue;
  }

  get url(): string {
    return `http://127.0.0.1:${this.portValue}`;
  }

  setMode(mode: StubMode): void {
    this.defaultMode = mode;
  }

  reset(): void {
    this.requests.length = 0;
    this.defaultMode = "stream";
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        try {
          res.writeHead(500).end();
        } catch {
          // Client already gone.
        }
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("stub provider failed to bind");
    }
    this.portValue = address.port;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private resolveMode(req: IncomingMessage): StubMode {
    const header = req.headers["x-stub-mode"];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw && (VALID_MODES as string[]).includes(raw)) {
      return raw as StubMode;
    }
    return this.defaultMode;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const mode = this.resolveMode(req);
    this.requests.push({
      method: (req.method ?? "GET").toUpperCase(),
      url: req.url ?? "/",
      stubMode: mode,
      body,
    });

    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "stub-model", object: "model" }],
        }),
      );
      return;
    }

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      if (mode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub failure" } }));
        return;
      }
      this.streamCompletion(res, mode);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub: not found" } }));
  }

  private streamCompletion(res: ServerResponse, mode: StubMode): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (payload: string): boolean => res.write(`data: ${payload}\n\n`);
    if (mode === "empty") {
      res.end("data: [DONE]\n\n");
      return;
    }
    const frames = [...STREAM_DELTAS.map(chunkPayload), usagePayload(), "[DONE]"];
    if (mode === "slow") {
      let i = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        send(frames[i]);
        i++;
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
        }
      }, 2000);
      res.on("close", () => clearInterval(timer));
      return;
    }
    for (const frame of frames) {
      send(frame);
    }
    res.end();
  }
}
