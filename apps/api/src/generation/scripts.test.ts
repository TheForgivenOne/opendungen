import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actions } from "../db/schema";
import { generateTurn } from "./pipeline";
import { AbortError } from "../llm/types";
import type { LLMChunk, LLMProvider, LLMRequest } from "../llm/types";
import { loadScriptStates } from "./hooks";
import { createTestApp, createStoryRows, seedScriptRows } from "../testing";

const STORY_FIELDS = {
  aiInstructions: "Narrate.",
  plotEssentials: "",
  summary: "",
  memory: "",
};

// Recording mock: captures the request the pipeline assembled so tests
// can assert on context-hook mutations, then streams fixed chunks.
function recordingMock(chunks: string[] = ["Hello", " world"]): LLMProvider & {
  lastRequest: LLMRequest | null;
} {
  const mock: LLMProvider & { lastRequest: LLMRequest | null } = {
    kind: "ollama",
    supportsCaching: false,
    supportsMultipleSystemMessages: false,
    tokenMultiplier: 1.0,
    lastRequest: null,
    async *complete(req: LLMRequest, _signal: AbortSignal): AsyncIterable<LLMChunk> {
      mock.lastRequest = req;
      for (const delta of chunks) {
        yield { delta, done: false };
      }
    },
    async testConnection() {
      return { ok: true as const, model: "mock" };
    },
    async listModels() {
      return { models: ["mock"], source: "listing" as const };
    },
  };
  return mock;
}

async function drain<T>(
  gen: AsyncGenerator<unknown, T, void>,
): Promise<{ events: unknown[]; result: T }> {
  const events: unknown[] = [];
  let done = await gen.next();
  while (!done.done) {
    events.push(done.value);
    done = await gen.next();
  }
  return { events, result: done.value };
}

// Scripts run at every hook (input, context, output); real scripts guard
// on which globals are defined, so the test scripts below do the same.

describe("pipeline script integration", () => {
  it("input hook rewrites the persisted input text", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    await seedScriptRows(db, storyId, ["s1"]);
    const provider = recordingMock();
    const { result } = await drain(
      generateTurn({
        db,
        storyId,
        story: STORY_FIELDS,
        actions: [],
        cards: [],
        userInput: "SHOUT hello",
        provider,
        signal: new AbortController().signal,
        scripts: [
          {
            id: "s1",
            name: "shout",
            source:
              'if (typeof text === "string" && text.includes("SHOUT")) text = text.toUpperCase();',
          },
        ],
        scriptStates: new Map(),
      }),
    );
    expect(result.scriptErrors).toEqual([]);
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: "input", text: "SHOUT HELLO" });
    // The provider saw the rewritten input in the final user message.
    const lastMessage = provider.lastRequest?.messages[provider.lastRequest.messages.length - 1];
    expect(lastMessage).toMatchObject({ role: "user", content: "SHOUT HELLO" });
  });

  it("context hook mutates the assembled system layer", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const provider = recordingMock();
    const { result } = await drain(
      generateTurn({
        db,
        storyId,
        story: STORY_FIELDS,
        actions: [],
        cards: [],
        userInput: "go",
        provider,
        signal: new AbortController().signal,
        scripts: [
          {
            id: "s1",
            name: "lore",
            source:
              'if (typeof context !== "undefined" && context !== null) context.memory = "The bridge is out.";',
          },
        ],
        scriptStates: new Map(),
      }),
    );
    expect(result.scriptErrors).toEqual([]);
    const system = provider.lastRequest?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("The bridge is out.");
  });

  it("output hook changes persisted text but not the streamed text", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    await seedScriptRows(db, storyId, ["s1"]);
    const provider = recordingMock();
    const { events, result } = await drain(
      generateTurn({
        db,
        storyId,
        story: STORY_FIELDS,
        actions: [],
        cards: [],
        userInput: "go",
        provider,
        signal: new AbortController().signal,
        // Tags both hooks' texts; the input keeps "go!" as well.
        scripts: [
          { id: "s1", name: "tag", source: 'if (typeof text === "string") text = text + "!";' },
        ],
        scriptStates: new Map(),
      }),
    );
    expect(result.scriptErrors).toEqual([]);
    const streamed = events
      .filter((e) => (e as { type: string }).type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(streamed).toBe("Hello world");
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows[0]).toMatchObject({ type: "input", text: "go!" });
    expect(rows[1]).toMatchObject({ type: "output", text: "Hello world!" });
  });

  it("script errors are collected per hook and do not fail the turn", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const { result } = await drain(
      generateTurn({
        db,
        storyId,
        story: STORY_FIELDS,
        actions: [],
        cards: [],
        userInput: "go",
        provider: recordingMock(),
        signal: new AbortController().signal,
        scripts: [{ id: "bad", name: "Bad", source: 'throw new Error("nope");' }],
        scriptStates: new Map(),
      }),
    );
    // The same script fails at each of the three hooks; the turn continues.
    expect(result.scriptErrors).toEqual([
      { scriptId: "bad", name: "Bad", message: "nope" },
      { scriptId: "bad", name: "Bad", message: "nope" },
      { scriptId: "bad", name: "Bad", message: "nope" },
    ]);
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(2);
  });

  it("state changes persist across hooks within a turn", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    await seedScriptRows(db, storyId, ["s1"]);
    const source = [
      'state.phases = (state.phases || []).concat(typeof context !== "undefined" ? "ctx" : "io");',
      'if (typeof text === "string" && state.phases.length === 3) text = text + "#" + state.phases.length;',
    ].join("\n");
    const { result } = await drain(
      generateTurn({
        db,
        storyId,
        story: STORY_FIELDS,
        actions: [],
        cards: [],
        userInput: "go",
        provider: recordingMock(["out"]),
        signal: new AbortController().signal,
        scripts: [{ id: "s1", name: "phases", source }],
        scriptStates: new Map(),
      }),
    );
    expect(result.scriptErrors).toEqual([]);
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows[1].text).toBe("out#3");
    expect(await loadScriptStates(db, storyId)).toEqual(
      new Map([["s1", { phases: ["io", "ctx", "io"] }]]),
    );
  });

  it("abort mid-stream does not run the output hook", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    await seedScriptRows(db, storyId, ["s1"]);
    const controller = new AbortController();
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "go",
      provider: recordingMock(["one", "two", "three"]),
      signal: controller.signal,
      scripts: [
        {
          id: "s1",
          name: "phases",
          source:
            'state.phases = (state.phases || []).concat(typeof context !== "undefined" ? "ctx" : "io");',
        },
      ],
      scriptStates: new Map(),
    });
    await gen.next(); // meta
    controller.abort();
    await expect(gen.next()).rejects.toThrowError(AbortError);
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "input" });
    // Input and context hooks ran; the output hook never did.
    expect(await loadScriptStates(db, storyId)).toEqual(
      new Map([["s1", { phases: ["io", "ctx"] }]]),
    );
  });
});
