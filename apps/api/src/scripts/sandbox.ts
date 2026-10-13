// QuickJS sandbox internals: runtime creation with the shared globals
// installed (deterministic Math.random, log, frozen history). The caller
// sets per-script state/text/context, then disposes via done().

import { getSandboxQuickJS } from "./qjs-module";
import {
  isFail,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import type { ContextPayload, HistoryEntry } from "./types";

// Deterministic PRNG injected as Math.random. FNV-1a hashes the seed,
// mulberry32 generates the sequence: the same seed always yields the
// same numbers, so tests are reproducible.
const PRNG_SOURCE = `
(function () {
  var seedText = __hookSeed;
  var h = 2166136261 >>> 0;
  for (var i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  var s = h >>> 0;
  Math.random = function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
`;

export function unwrapEval(ctx: QuickJSContext, code: string): { value?: unknown; error?: string } {
  const result = ctx.evalCode(code);
  if (isFail(result)) {
    const dumped = ctx.dump(result.error) as { message?: unknown } | null;
    result.error.dispose();
    const message = dumped && typeof dumped.message === "string" ? dumped.message : "script error";
    return { error: message };
  }
  const value = ctx.dump(result.value);
  result.value.dispose();
  return { value };
}

export function setJsonGlobal(ctx: QuickJSContext, name: string, json: string): void {
  const parsed = ctx.evalCode(`(${json})`);
  if (isFail(parsed)) {
    parsed.error.dispose();
    throw new Error(`cannot initialize sandbox global ${name}`);
  }
  ctx.setProp(ctx.global, name, parsed.value);
  parsed.value.dispose();
}

export function readGlobal(ctx: QuickJSContext, name: string): unknown {
  const handle = ctx.getProp(ctx.global, name);
  const value = ctx.dump(handle);
  handle.dispose();
  return value;
}

function stringifyLogArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "unprintable";
  }
}

export interface Sandbox {
  runtime: QuickJSRuntime;
  ctx: QuickJSContext;
  timedOut: () => boolean;
  setScriptName: (name: string) => void;
}

// One runtime + context with the shared globals installed. The caller
// sets per-script state/text/context, then disposes via done().
export async function createSandbox(opts: {
  seed: string;
  timeoutMs: number;
  memoryLimitBytes: number;
  history: HistoryEntry[];
  logger: (message: string) => void;
}): Promise<{ sandbox: Sandbox; done: () => void }> {
  const QuickJS = await getSandboxQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(opts.memoryLimitBytes);
  const deadline = Date.now() + opts.timeoutMs;
  let timedOut = false;
  // NOTE: QuickJS interrupts when the handler returns non-zero.
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const ctx = runtime.newContext();
  // Strip time: scripts must be deterministic.
  ctx.setProp(ctx.global, "Date", ctx.undefined);

  // Deterministic Math.random, seeded per hook call.
  const seedHandle = ctx.newString(opts.seed);
  ctx.setProp(ctx.global, "__hookSeed", seedHandle);
  seedHandle.dispose();
  const prng = ctx.evalCode(PRNG_SOURCE);
  if (isFail(prng)) {
    prng.error.dispose();
    ctx.dispose();
    runtime.dispose();
    throw new Error("cannot initialize sandbox PRNG");
  }
  prng.value.dispose();
  unwrapEval(ctx, "delete globalThis.__hookSeed;");

  // log(msg): server debug log only, never echoed to the client.
  // One binding; the current script name is swapped per script.
  // NOTE: the callback must use rest params: quickjs-emscripten passes
  // call arguments through only to length-0 (variadic) callbacks.
  let scriptName = "";
  const logFn = ctx.newFunction("log", (...args: QuickJSHandle[]) => {
    try {
      const messageHandle = args[0];
      const dumped = messageHandle === undefined ? undefined : ctx.dump(messageHandle);
      opts.logger(`[script ${scriptName}] ${stringifyLogArg(dumped)}`);
    } catch {
      opts.logger(`[script ${scriptName}] unprintable`);
    }
    return ctx.undefined;
  });
  ctx.setProp(ctx.global, "log", logFn);
  logFn.dispose();

  // Read-only history snapshot.
  setJsonGlobal(ctx, "history", JSON.stringify(opts.history.slice(-10)));
  unwrapEval(ctx, "Object.freeze(history); for (const entry of history) Object.freeze(entry);");

  const sandbox: Sandbox = {
    runtime,
    ctx,
    timedOut: () => timedOut,
    setScriptName: (name: string) => {
      scriptName = name;
    },
  };
  return {
    sandbox,
    done: () => {
      ctx.dispose();
      runtime.dispose();
    },
  };
}

export function describeFailure(timedOut: boolean, timeoutMs: number, message: string): string {
  return timedOut ? `script timed out after ${timeoutMs}ms` : message;
}

export function checkContextFields(next: unknown): ContextPayload | string {
  if (next === null || typeof next !== "object" || Array.isArray(next)) {
    return "context must remain an object";
  }
  const record = next as Record<string, unknown>;
  for (const field of ["instructions", "plotEssentials", "summary", "memory"] as const) {
    if (typeof record[field] !== "string") {
      return `${field} must remain a string`;
    }
  }
  if (
    !Array.isArray(record.cards) ||
    !record.cards.every((entry: unknown) => typeof entry === "string")
  ) {
    return "cards must remain an array of strings";
  }
  return {
    instructions: record.instructions as string,
    plotEssentials: record.plotEssentials as string,
    summary: record.summary as string,
    memory: record.memory as string,
    cards: (record.cards as string[]).slice(),
  };
}
