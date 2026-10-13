import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_BUDGET } from "@opendungen/shared";
import { getLocalDb } from "../db.local";
import { compressedRanges } from "../db/schema";
import { createStoryRows } from "../testing";
import { AbortError, ProviderError, type LLMProvider, type LLMRequest } from "../llm/types";
import { estimateTokens } from "./assemble";
import {
  attemptCompression,
  buildCompressionDigest,
  insertCompressedRange,
  parseCompressionDecision,
  shouldAttemptCompression,
  validateCompressionRange,
  type CompressionAction,
  type ExistingCompressionRange,
} from "./compress";

// Yields one fixed text answer and records the request it answered.
function textProvider(
  text: string,
  onRequest?: (req: LLMRequest) => void,
): { provider: LLMProvider; requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    requests,
    provider: {
      kind: "ollama",
      supportsCaching: false,
      supportsMultipleSystemMessages: false,
      tokenMultiplier: 1.0,
      async *complete(req: LLMRequest, _signal: AbortSignal) {
        requests.push(req);
        onRequest?.(req);
        yield { delta: text, done: false };
      },
      async testConnection() {
        return { ok: true as const, model: "test" };
      },
      async listModels() {
        return { models: ["test"], source: "listing" as const };
      },
    },
  };
}

function throwingProvider(error: Error): LLMProvider {
  return {
    kind: "ollama",
    supportsCaching: false,
    supportsMultipleSystemMessages: false,
    tokenMultiplier: 1.0,
    async *complete(_req: LLMRequest, _signal: AbortSignal) {
      throw error;
    },
    async testConnection() {
      return { ok: true as const, model: "test" };
    },
    async listModels() {
      return { models: ["test"], source: "listing" as const };
    },
  };
}

const STORY = { id: "story-1", title: "Test Tale" };

function actions(n: number, chars = 20): CompressionAction[] {
  return Array.from({ length: n }, (_, i) => ({
    idx: i,
    type: i % 2 === 0 ? "input" : "output",
    text: `action ${i} ${"x".repeat(chars)}`,
  }));
}

function range(id: string, startIdx: number, endIdx: number): ExistingCompressionRange {
  return { id, startIdx, endIdx, summary: `summary ${id}` };
}

function freshDb() {
  const db = getLocalDb(":memory:");
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe("shouldAttemptCompression", () => {
  it("is false for a short story", () => {
    expect(
      shouldAttemptCompression({
        story: { aiInstructions: "", plotEssentials: "", memory: "", summary: "" },
        actions: actions(4),
        tokenMultiplier: 1.0,
      }),
    ).toBe(false);
  });

  it("is true once estimated tokens cross 60% of the budget", () => {
    // 60% of 8192 = 4915.2 tokens ≈ 19661 chars at multiplier 1.
    const big = actions(10, 2000);
    expect(
      shouldAttemptCompression({
        story: { aiInstructions: "", plotEssentials: "", memory: "", summary: "" },
        actions: big,
        tokenMultiplier: 1.0,
      }),
    ).toBe(true);
  });

  it("honours a budget override (used to force the trigger in tests)", () => {
    expect(
      shouldAttemptCompression({
        story: { aiInstructions: "", plotEssentials: "", memory: "", summary: "" },
        actions: actions(2),
        tokenMultiplier: 1.0,
        budget: { ...DEFAULT_CONTEXT_BUDGET, compressTriggerPct: 0.000001 },
      }),
    ).toBe(true);
  });
});

describe("attemptCompression", () => {
  it("sends a short non-streamed request with the compressor prompt", async () => {
    const { provider, requests } = textProvider('{"shouldCompress": false}');
    const decision = await attemptCompression({
      story: STORY,
      actions: actions(8),
      existingRanges: [],
      provider,
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ shouldCompress: false });
    expect(requests).toHaveLength(1);
    expect(requests[0].maxTokens).toBe(600);
    expect(requests[0].temperature).toBe(0.2);
    expect(requests[0].messages[0].role).toBe("system");
    expect(requests[0].messages[0].content).toContain("story compression engine");
    expect(requests[0].messages[1].role).toBe("user");
  });

  it("returns a valid true decision with its fields", async () => {
    const { provider } = textProvider(
      '{"shouldCompress": true, "startIdx": 0, "endIdx": 3, "summary": "They left town."}',
    );
    const decision = await attemptCompression({
      story: STORY,
      actions: actions(8),
      existingRanges: [],
      provider,
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({
      shouldCompress: true,
      startIdx: 0,
      endIdx: 3,
      summary: "They left town.",
    });
  });

  it("treats malformed JSON as shouldCompress=false", () => {
    expect(parseCompressionDecision("not json {{{")).toEqual({ shouldCompress: false });
    expect(parseCompressionDecision("")).toEqual({ shouldCompress: false });
  });

  it("treats explicit false and incomplete true decisions as false", () => {
    expect(parseCompressionDecision('{"shouldCompress": false}')).toEqual({
      shouldCompress: false,
    });
    expect(parseCompressionDecision('{"shouldCompress": true, "startIdx": 0}')).toEqual({
      shouldCompress: false,
    });
    expect(
      parseCompressionDecision(
        '{"shouldCompress": true, "startIdx": 0, "endIdx": 2, "summary": ""}',
      ),
    ).toEqual({ shouldCompress: false });
    expect(parseCompressionDecision('{"nope": 1}')).toEqual({ shouldCompress: false });
  });

  it("swallows provider errors and aborts", async () => {
    for (const error of [new ProviderError("network", "down"), new AbortError()]) {
      const decision = await attemptCompression({
        story: STORY,
        actions: actions(8),
        existingRanges: [],
        provider: throwingProvider(error),
        signal: new AbortController().signal,
      });
      expect(decision).toEqual({ shouldCompress: false });
    }
  });
});

describe("buildCompressionDigest", () => {
  it("lists ranges first, then raw actions truncated to 200 chars", () => {
    const digest = buildCompressionDigest(
      STORY,
      [
        { idx: 0, type: "input", text: "covered" },
        { idx: 1, type: "output", text: "covered too" },
        { idx: 2, type: "input", text: `raw ${"y".repeat(500)}` },
      ],
      [range("r1", 0, 1)],
      1.0,
    );
    const lines = digest.split("\n");
    expect(lines[0]).toBe("Story: Test Tale");
    expect(lines[1]).toBe("[range:0-1] summary r1");
    // Covered actions never appear raw; the raw action is cut to 200 chars.
    expect(digest).not.toContain("covered");
    const rawLine = lines[2];
    expect(rawLine.startsWith("[2] input: raw ")).toBe(true);
    expect(rawLine.length).toBeLessThanOrEqual("[2] input: ".length + 200);
  });

  it("caps the digest at 4000 tokens, dropping oldest raw actions first", () => {
    // Raw lines are pre-truncated to 200 chars (~57t each), so it
    // takes ~70 of them to overflow the 4000t cap.
    const many = Array.from({ length: 120 }, (_, i) => ({
      idx: i,
      type: i % 2 === 0 ? "input" : "output",
      text: `event number ${i} ` + "z".repeat(500),
    }));
    const digest = buildCompressionDigest(STORY, many, [range("keep", 0, 1)], 1.0);
    expect(estimateTokens(digest.length, 1.0)).toBeLessThanOrEqual(4000);
    // Ranges keep priority; the oldest raw actions are gone; newer survive.
    expect(digest).toContain("[range:0-1] summary keep");
    expect(digest).not.toContain("[2] input:");
    expect(digest).toContain("[119]");
  });
});

describe("validateCompressionRange + insertCompressedRange", () => {
  it("inserts a valid decision with correct fields", async () => {
    const db = freshDb();
    const { storyId } = await createStoryRows(db);
    const decision = { startIdx: 0, endIdx: 3, summary: "They left town." };
    const validation = validateCompressionRange(decision, actions(8), []);
    expect(validation).toEqual({ ok: true, parentRangeId: null });
    const row = await insertCompressedRange(
      db,
      storyId,
      decision,
      validation.ok ? validation.parentRangeId : null,
    );
    expect(row.storyId).toBe(storyId);
    expect(row.startIdx).toBe(0);
    expect(row.endIdx).toBe(3);
    expect(row.summary).toBe("They left town.");
    expect(row.parentRangeId).toBeNull();
    const stored = await db.select().from(compressedRanges).where(eq(compressedRanges.id, row.id));
    expect(stored).toHaveLength(1);
    expect(stored[0].summary).toBe("They left town.");
  });

  it("rejects inverted bounds, out-of-bounds, and empty logs", () => {
    expect(validateCompressionRange({ startIdx: 3, endIdx: 3 }, actions(8), []).ok).toBe(false);
    expect(validateCompressionRange({ startIdx: 4, endIdx: 2 }, actions(8), []).ok).toBe(false);
    expect(validateCompressionRange({ startIdx: -1, endIdx: 2 }, actions(8), []).ok).toBe(false);
    expect(validateCompressionRange({ startIdx: 0, endIdx: 8 }, actions(8), []).ok).toBe(false);
    expect(validateCompressionRange({ startIdx: 0, endIdx: 2 }, [], []).ok).toBe(false);
  });

  it("rejects ranges that include the last 3 actions", () => {
    // 8 actions, idx 0..7: the last 3 are 5,6,7, so endIdx must be <= 4.
    expect(validateCompressionRange({ startIdx: 4, endIdx: 7 }, actions(8), []).ok).toBe(false);
    expect(validateCompressionRange({ startIdx: 4, endIdx: 5 }, actions(8), []).ok).toBe(false);
    expect(validateCompressionRange({ startIdx: 3, endIdx: 4 }, actions(8), [])).toEqual({
      ok: true,
      parentRangeId: null,
    });
  });

  it("rejects partial overlaps with existing ranges", () => {
    const existing = [range("e", 2, 5)];
    expect(validateCompressionRange({ startIdx: 4, endIdx: 7 }, actions(12), existing).ok).toBe(
      false,
    );
    expect(validateCompressionRange({ startIdx: 0, endIdx: 3 }, actions(12), existing).ok).toBe(
      false,
    );
  });

  it("parents a containing range to the outermost contained range", () => {
    const existing = [range("inner", 5, 6), range("outer", 2, 3)];
    const validation = validateCompressionRange({ startIdx: 0, endIdx: 9 }, actions(14), existing);
    expect(validation).toEqual({ ok: true, parentRangeId: "outer" });
  });

  it("parents a nested range to its innermost container", () => {
    const existing = [range("big", 0, 9), range("small", 1, 8)];
    const validation = validateCompressionRange({ startIdx: 2, endIdx: 5 }, actions(14), existing);
    expect(validation).toEqual({ ok: true, parentRangeId: "small" });
  });
});
