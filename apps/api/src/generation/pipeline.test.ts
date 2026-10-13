import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actions } from "../db/schema";
import { BASE_SYSTEM_PROMPT, MODE_DIRECTIVES, OUTPUT_CONSTRAINTS } from "../context/prompts";
import { generateTurn, type PipelineAction } from "./pipeline";
import { AbortError, ProviderError, type LLMProvider, type LLMRequest } from "../llm/types";
import { appendAction } from "../action-log";
import { createMockProvider, createStoryRows, createTestApp } from "../testing";

const STORY_FIELDS = {
  aiInstructions: "Narrate.",
  plotEssentials: "",
  summary: "",
  memory: "",
};

describe("pipeline", () => {
  it("persists input at N and output at N+1 on success", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);

    const provider = createMockProvider({ chunks: ["Hello", " world"] });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "look around",
      provider,
      signal: new AbortController().signal,
    });
    const events: unknown[] = [];
    let done = await gen.next();
    while (!done.done) {
      events.push(done.value);
      done = await gen.next();
    }
    const result = done.value;
    expect(events[0]).toMatchObject({ type: "meta", inputActionId: result.inputActionId });
    expect(events.filter((e) => (e as { type: string }).type === "delta")).toHaveLength(2);
    expect(result.outputActionId).toBeTruthy();

    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ idx: 0, type: "input", text: "look around" });
    expect(rows[1]).toMatchObject({ idx: 1, type: "output", text: "Hello world" });
    expect(rows[0].id).toBe(result.inputActionId);
    expect(rows[1].id).toBe(result.outputActionId);
  });

  it("on abort persists only the input action", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);

    const provider = createMockProvider({ chunks: ["one", "two", "three"] });
    const controller = new AbortController();
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "go north",
      provider,
      signal: controller.signal,
    });
    const meta = await gen.next();
    expect(meta.done).toBe(false);
    controller.abort();
    await expect(gen.next()).rejects.toThrowError(AbortError);

    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idx: 0, type: "input", text: "go north" });
  });

  it("on error persists the input but no output", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);

    const provider = createMockProvider({ error: new ProviderError("auth", "bad key") });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "go south",
      provider,
      signal: new AbortController().signal,
    });
    await gen.next(); // meta is yielded before the provider fails
    await expect(gen.next()).rejects.toThrowError(ProviderError);

    // The typed input is kept as a lone input so the turn can be
    // retried; no output row exists.
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idx: 0, type: "input", text: "go south" });
  });

  it("on mid-stream error keeps the input and drops partial output", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);

    const provider: Parameters<typeof generateTurn>[0]["provider"] = {
      kind: "ollama",
      supportsCaching: false,
      supportsMultipleSystemMessages: false,
      tokenMultiplier: 1.0,
      async *complete() {
        yield { delta: "partial ", done: false };
        throw new ProviderError("unknown", "connection reset", 500);
      },
      async testConnection() {
        return { ok: true as const, model: "m" };
      },
      async listModels() {
        return { models: ["m"], source: "listing" as const };
      },
    };
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "go east",
      provider,
      signal: new AbortController().signal,
    });
    const events: unknown[] = [];
    let done = await gen.next();
    while (!done.done) {
      events.push(done.value);
      try {
        done = await gen.next();
      } catch {
        break;
      }
    }
    expect(events.filter((e) => (e as { type: string }).type === "delta")).toHaveLength(1);

    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idx: 0, type: "input", text: "go east" });
  });

  it("retry reuses the existing input action", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);

    await appendAction(db, storyId, "input", "open the door");
    const stale = await appendAction(db, storyId, "output", "stale narration");
    // The retry endpoint deletes the old output before generating.
    await db.delete(actions).where(eq(actions.id, stale.id));
    const remaining = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(remaining).toHaveLength(1);

    const prior: PipelineAction[] = remaining.map((r) => ({
      id: r.id,
      idx: r.idx,
      type: r.type,
      text: r.text,
    }));
    const provider = createMockProvider({ chunks: ["fresh narration"] });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: prior,
      cards: [],
      userInput: prior[0].text,
      provider,
      signal: new AbortController().signal,
      reuseInputActionId: prior[0].id,
    });
    let done = await gen.next();
    while (!done.done) {
      done = await gen.next();
    }
    const after = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ idx: 0, type: "input", text: "open the door" });
    expect(after[1]).toMatchObject({ idx: 1, type: "output", text: "fresh narration" });
    expect(done.value.inputActionId).toBe(prior[0].id);
  });
});

// Recording mock with multi-system support, so tests can assert on
// the layered prompt shape exactly as assembled.
function layeredMock(singleSystem = false): LLMProvider & { lastRequest: LLMRequest | null } {
  const mock: LLMProvider & { lastRequest: LLMRequest | null } = {
    kind: singleSystem ? "ollama" : "anthropic",
    supportsCaching: !singleSystem,
    supportsMultipleSystemMessages: !singleSystem,
    tokenMultiplier: 1.0,
    lastRequest: null,
    async *complete(req: LLMRequest, _signal: AbortSignal) {
      mock.lastRequest = req;
      yield { delta: "out", done: false };
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

async function drainTurn(
  gen: AsyncGenerator<unknown, { outputActionId: string }, void>,
): Promise<void> {
  let done = await gen.next();
  while (!done.done) {
    done = await gen.next();
  }
}

describe("pipeline prompt shape", () => {
  const LAYERS = {
    aiInstructions: "grim scene rules",
    plotEssentials: "The lantern must stay lit.",
    summary: "A traveler arrived.",
    memory: "the vault is open",
  };

  it("sends the layered prompt: base, constraints, scenario, mode, plot, summary, note, input", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const provider = layeredMock();
    await drainTurn(
      generateTurn({
        db,
        storyId,
        story: LAYERS,
        actions: [],
        cards: [],
        userInput: "You look around",
        mode: "do",
        provider,
        signal: new AbortController().signal,
      }),
    );
    const messages = provider.lastRequest?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "user",
    ]);
    expect(messages[0].content).toBe(BASE_SYSTEM_PROMPT);
    expect(messages[1].content).toBe(OUTPUT_CONSTRAINTS);
    expect(messages[2].content).toBe("grim scene rules");
    expect(messages[3].content).toBe(MODE_DIRECTIVES.do);
    expect(messages[4].content).toContain("Plot Essentials:");
    expect(messages[5].content).toContain("Story Summary:");
    expect(messages[6].content).toBe("Author's Note: [the vault is open]");
    expect(messages[7]).toMatchObject({ role: "user", content: "> You look around" });
    // The stable prefix runs through Plot/Summary (no cards here).
    expect(provider.lastRequest?.cachePrefixUpTo).toBe(5);
  });

  it("formats mode=do input with '> ' and mode=story with no prefix", async () => {
    for (const [mode, expected] of [
      ["do", "> You look around"],
      ["story", "The lantern gutters."],
    ] as const) {
      const { db } = createTestApp();
      const { storyId } = await createStoryRows(db);
      const provider = layeredMock();
      await drainTurn(
        generateTurn({
          db,
          storyId,
          story: { aiInstructions: "", plotEssentials: "", summary: "", memory: "" },
          actions: [],
          cards: [],
          userInput: expected.startsWith("> ") ? expected.slice(2) : expected,
          mode,
          provider,
          signal: new AbortController().signal,
        }),
      );
      const messages = provider.lastRequest?.messages ?? [];
      expect(messages[messages.length - 1]).toMatchObject({ role: "user", content: expected });
    }
  });

  it("joins system blocks into one message when the provider opts out", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    // Same recorder, but kind ollama: one leading system message.
    const provider = layeredMock(true);
    await drainTurn(
      generateTurn({
        db,
        storyId,
        story: LAYERS,
        actions: [],
        cards: [],
        userInput: "You look around",
        mode: "do",
        provider,
        signal: new AbortController().signal,
      }),
    );
    const messages = provider.lastRequest?.messages ?? [];
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(messages[0].content).toContain(BASE_SYSTEM_PROMPT);
    expect(messages[0].content).toContain("Author's Note: [the vault is open]");
    expect(messages[messages.length - 1]).toMatchObject({
      role: "user",
      content: "> You look around",
    });
  });
});
