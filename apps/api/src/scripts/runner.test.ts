import { describe, expect, it } from "vitest";
import { runHook, validateScript } from "./runner";
import type { HookScript } from "./types";

function script(id: string, source: string, name = id): HookScript {
  return { id, name, source };
}

describe("sandbox surface", () => {
  it("denies network, modules, timers, console, process, and Date", async () => {
    const probes: Record<string, string> = {
      fetch: "typeof fetch",
      xhr: "typeof XMLHttpRequest",
      require: "typeof require",
      setTimeout: "typeof setTimeout",
      setInterval: "typeof setInterval",
      console: "typeof console",
      process: "typeof process",
      date: "typeof Date",
      globalFetch: "typeof globalThis.fetch",
      globalProcess: "typeof globalThis.process",
    };
    for (const [label, expr] of Object.entries(probes)) {
      const result = await runHook({
        hook: "input",
        scripts: [script(`probe-${label}`, `text = ${expr};`)],
        states: new Map(),
        payload: { text: "" },
        logger: () => {},
      });
      expect(result.errors).toEqual([]);
      expect(result.value.text).toBe("undefined");
    }
  });

  it("rejects import statements and require calls as script errors", async () => {
    const imp = await runHook({
      hook: "input",
      scripts: [script("imp", 'import x from "y";')],
      states: new Map(),
      payload: { text: "" },
      logger: () => {},
    });
    expect(imp.errors).toHaveLength(1);
    expect(imp.value.text).toBe("");

    const req = await runHook({
      hook: "input",
      scripts: [script("req", 'const fs = require("fs");')],
      states: new Map(),
      payload: { text: "" },
      logger: () => {},
    });
    expect(req.errors).toHaveLength(1);
    expect(req.value.text).toBe("");
  });

  it("throws on any Date use inside scripts", async () => {
    for (const source of ["text = String(new Date());", "text = String(Date.now());"]) {
      const result = await runHook({
        hook: "input",
        scripts: [script("dates", source)],
        states: new Map(),
        payload: { text: "" },
        logger: () => {},
      });
      expect(result.errors).toHaveLength(1);
      expect(result.value.text).toBe("");
    }
  });

  it("times out runaway scripts", async () => {
    const result = await runHook({
      hook: "input",
      scripts: [script("loop", "while (true) {}")],
      states: new Map(),
      payload: { text: "kept" },
      timeoutMs: 50,
      logger: () => {},
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("timed out");
    expect(result.value.text).toBe("kept");
  });

  it("enforces the memory limit", async () => {
    const result = await runHook({
      hook: "input",
      scripts: [
        script("hog", 'let s = ""; for (let i = 0; i < 2000000; i++) s += "abcdefgh" + i;'),
      ],
      states: new Map(),
      payload: { text: "kept" },
      memoryLimitBytes: 256 * 1024,
      timeoutMs: 10000,
      logger: () => {},
    });
    expect(result.errors).toHaveLength(1);
    expect(result.value.text).toBe("kept");
  });

  it("seeds Math.random deterministically per hook call", async () => {
    const source = "text = [Math.random(), Math.random(), Math.random()].join(',');";
    const run = (seed: string) =>
      runHook({
        hook: "input",
        scripts: [script("rand", source)],
        states: new Map(),
        payload: { text: "" },
        seed,
        logger: () => {},
      });
    const first = await run("story-1:3:input");
    const second = await run("story-1:3:input");
    expect(first.errors).toEqual([]);
    expect(first.value.text).toBe(second.value.text);
    expect(first.value.text).toMatch(/^[0-9.,]+$/);
    const other = await run("story-1:4:input");
    expect(other.value.text).not.toBe(first.value.text);
  });
});

describe("hook values", () => {
  it("threads text through input scripts in order", async () => {
    const result = await runHook({
      hook: "input",
      scripts: [script("a", 'text = text + "[A]";'), script("b", 'text = text + "[B]";')],
      states: new Map(),
      payload: { text: "go" },
      logger: () => {},
    });
    expect(result.errors).toEqual([]);
    expect(result.value.text).toBe("go[A][B]");
  });

  it("isolates errors: one bad script does not block the others", async () => {
    const logs: string[] = [];
    const result = await runHook({
      hook: "input",
      scripts: [
        script("good-first", 'text = text + "1";'),
        script("bad", 'throw new Error("kaboom");', "Bad Script"),
        script("good-last", 'text = text + "3";'),
      ],
      states: new Map(),
      payload: { text: "" },
      logger: (message: string) => logs.push(message),
    });
    expect(result.value.text).toBe("13");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      scriptId: "bad",
      name: "Bad Script",
      message: "kaboom",
    });
  });

  it("rejects non-string text assignments", async () => {
    const result = await runHook({
      hook: "input",
      scripts: [script("num", "text = 42;")],
      states: new Map(),
      payload: { text: "kept" },
      logger: () => {},
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("text must remain a string");
    expect(result.value.text).toBe("kept");
  });

  it("rejects context shape violations", async () => {
    const result = await runHook({
      hook: "context",
      scripts: [script("wrecker", "context = null;")],
      states: new Map(),
      payload: { instructions: "a", plotEssentials: "", summary: "", memory: "", cards: [] },
      logger: () => {},
    });
    expect(result.errors).toHaveLength(1);
    expect(result.value.instructions).toBe("a");
  });

  it("exposes a frozen history snapshot of the last 10 actions", async () => {
    const actions = Array.from({ length: 14 }, (_, i) => ({
      type: i % 2 === 0 ? "input" : "output",
      text: `action ${i}`,
    }));
    const result = await runHook({
      hook: "input",
      scripts: [
        script(
          "hist",
          'text = history.length + ":" + history[0].text + ":" + history[9].text + ":" + Object.isFrozen(history);',
        ),
      ],
      states: new Map(),
      payload: { text: "" },
      history: actions,
      logger: () => {},
    });
    expect(result.errors).toEqual([]);
    expect(result.value.text).toBe("10:action 4:action 13:true");
  });

  it("history mutations do not escape the sandbox", async () => {
    const first = await runHook({
      hook: "input",
      scripts: [script("mut", 'history.push({ type: "input", text: "evil" });')],
      states: new Map(),
      payload: { text: "" },
      history: [{ type: "input", text: "real" }],
      logger: () => {},
    });
    // Frozen push throws in strict mode... quickjs sloppy mode silently
    // ignores it; either way the host array below is unaffected.
    expect(first.value.text).toBe("");
    const second = await runHook({
      hook: "input",
      scripts: [script("read", "text = String(history.length);")],
      states: new Map(),
      payload: { text: "" },
      history: [{ type: "input", text: "real" }],
      logger: () => {},
    });
    expect(second.value.text).toBe("1");
    expect(first.errors.length + second.errors.length).toBeLessThanOrEqual(1);
  });

  it("routes log() to the logger with the script name", async () => {
    const logs: string[] = [];
    const result = await runHook({
      hook: "input",
      scripts: [script("talker", 'log("hello"); log({ n: 1 });', "Talker")],
      states: new Map(),
      payload: { text: "" },
      logger: (message: string) => logs.push(message),
    });
    expect(result.errors).toEqual([]);
    expect(logs).toEqual(["[script Talker] hello", '[script Talker] {"n":1}']);
  });
});

describe("state tracking", () => {
  it("reports changed states; each script has isolated state", async () => {
    const states = new Map<string, unknown>();
    const result = await runHook({
      hook: "input",
      scripts: [
        script("writer", "state.count = (state.count || 0) + 1;"),
        script("reader", 'text = "count=" + state.count;'),
      ],
      states,
      payload: { text: "" },
      logger: () => {},
    });
    expect(result.errors).toEqual([]);
    // Each script has isolated state: the reader sees only its own.
    expect(result.value.text).toBe("count=undefined");
    expect(result.updatedStates.get("writer")).toBe('{"count":1}');
    expect(result.updatedStates.has("reader")).toBe(false);
    expect(states.get("writer")).toEqual({ count: 1 });
  });

  it("threads one script's state across hook calls via the shared map", async () => {
    const states = new Map<string, unknown>();
    const scripts = [script("counter", "state.n = (state.n || 0) + 1;")];
    const first = await runHook({
      hook: "input",
      scripts,
      states,
      payload: { text: "" },
      logger: () => {},
    });
    expect(first.updatedStates.get("counter")).toBe('{"n":1}');
    const second = await runHook({
      hook: "context",
      scripts,
      states,
      payload: { instructions: "", plotEssentials: "", summary: "", memory: "", cards: [] },
      logger: () => {},
    });
    expect(second.errors).toEqual([]);
    expect(second.updatedStates.get("counter")).toBe('{"n":2}');
  });

  it("enforces the 64 KB state cap and keeps the old state", async () => {
    const states = new Map<string, unknown>([["big", { kept: true }]]);
    const result = await runHook({
      hook: "input",
      scripts: [script("big", 'state.blob = "x".repeat(70000);')],
      states,
      payload: { text: "" },
      logger: () => {},
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("64 KB");
    expect(result.updatedStates.has("big")).toBe(false);
    expect(states.get("big")).toEqual({ kept: true });
  });
});

describe("validateScript", () => {
  it("accepts a valid script", async () => {
    await expect(validateScript("text = text.toUpperCase();")).resolves.toEqual({ ok: true });
  });

  it("rejects syntax errors", async () => {
    const result = await validateScript("function broken( {");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects top-level runtime errors", async () => {
    const result = await validateScript('throw new Error("nope");');
    expect(result).toMatchObject({ ok: false });
  });

  it("enforces the validation timeout", async () => {
    const result = await validateScript("while (true) {}", 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out");
    }
  });
});
