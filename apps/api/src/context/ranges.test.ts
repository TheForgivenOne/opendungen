import { describe, expect, it } from "vitest";
import { assembleContext, type AssembledContext, type AssembleRange } from "./assemble";

const STORY = { aiInstructions: "", plotEssentials: "", memory: "", summary: "" };

function storyActions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    idx: i,
    type: i % 2 === 0 ? "input" : "output",
    text: `action ${i}`,
  }));
}

function baseInput(ranges: AssembleRange[], restoreRangeIds?: string[]) {
  return {
    story: STORY,
    actions: storyActions(6),
    cards: [],
    mode: "story" as const,
    newInput: "go north",
    tokenMultiplier: 1.0,
    ranges,
    restoreRangeIds,
  };
}

// History under the layered prompt: messages after the leading
// system run, excluding a trailing user input.
function historyOf(ctx: AssembledContext) {
  let start = 0;
  while (start < ctx.messages.length && ctx.messages[start].role === "system") {
    start += 1;
  }
  let end = ctx.messages.length;
  if (end > start && ctx.messages[end - 1].role === "user") {
    end -= 1;
  }
  return ctx.messages.slice(start, end);
}

describe("compressed ranges in assembly", () => {
  it("replaces covered actions with one summary at the startIdx position", () => {
    const ctx = assembleContext(
      baseInput([{ id: "r1", startIdx: 1, endIdx: 3, summary: "the middle part" }]),
    );
    const history = historyOf(ctx);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history.map((m) => m.content)).toEqual([
      "action 0",
      "[summary of idx 1–3]: the middle part",
      "action 4",
      "action 5",
    ]);
    expect(ctx.rangesApplied).toEqual([{ id: "r1", startIdx: 1, endIdx: 3 }]);
    expect(ctx.messages[ctx.messages.length - 1]).toMatchObject({
      role: "user",
      content: "go north",
    });
  });

  it("emits only the outermost message for nested ranges", () => {
    const ctx = assembleContext(
      baseInput([
        { id: "child", startIdx: 1, endIdx: 2, summary: "child bit" },
        { id: "parent", startIdx: 0, endIdx: 5, summary: "the whole arc" },
      ]),
    );
    const history = historyOf(ctx);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      role: "assistant",
      content: "[summary of idx 0–5]: the whole arc",
    });
    expect(ctx.rangesApplied).toEqual([{ id: "parent", startIdx: 0, endIdx: 5 }]);
  });

  it("suppresses a restored range's summary and includes its actions verbatim", () => {
    const ctx = assembleContext(
      baseInput([{ id: "r1", startIdx: 1, endIdx: 3, summary: "the middle part" }], ["r1"]),
    );
    const history = historyOf(ctx);
    expect(history.map((m) => m.content)).toEqual([
      "action 0",
      "action 1",
      "action 2",
      "action 3",
      "action 4",
      "action 5",
    ]);
    expect(ctx.rangesApplied).toEqual([]);
  });

  it("lets an active child surface when its parent is restored", () => {
    const ctx = assembleContext(
      baseInput(
        [
          { id: "parent", startIdx: 0, endIdx: 5, summary: "the whole arc" },
          { id: "child", startIdx: 1, endIdx: 2, summary: "child bit" },
        ],
        ["parent"],
      ),
    );
    const history = historyOf(ctx);
    expect(history.map((m) => m.content)).toEqual([
      "action 0",
      "[summary of idx 1–2]: child bit",
      "action 3",
      "action 4",
      "action 5",
    ]);
    expect(ctx.rangesApplied).toEqual([{ id: "child", startIdx: 1, endIdx: 2 }]);
  });

  it("keeps a restored child suppressed under an active parent", () => {
    const ctx = assembleContext(
      baseInput(
        [
          { id: "parent", startIdx: 0, endIdx: 5, summary: "the whole arc" },
          { id: "child", startIdx: 1, endIdx: 2, summary: "child bit" },
        ],
        ["child"],
      ),
    );
    const history = historyOf(ctx);
    expect(history.map((m) => m.content)).toEqual(["[summary of idx 0–5]: the whole arc"]);
    expect(ctx.rangesApplied).toEqual([{ id: "parent", startIdx: 0, endIdx: 5 }]);
  });

  it("counts range summaries against the history budget", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      idx: i,
      type: i % 2 === 0 ? "input" : "output",
      text: `action number ${i} with enough words to cost tokens ${"x".repeat(60)}`,
    }));
    // History cap = 50% of 30% of 400 = 60 tokens: only the newest fit,
    // so the old range summary at idx 0 is trimmed out of the messages.
    const ctx = assembleContext({
      story: STORY,
      actions: many,
      cards: [],
      mode: "story",
      newInput: "next",
      tokenMultiplier: 1.0,
      ranges: [{ id: "old", startIdx: 0, endIdx: 1, summary: "ancient history" }],
      budget: {
        totalTokens: 400,
        requiredCapPct: 0.7,
        dynamicSplit: { cards: 0.25, history: 0.5, memory: 0.25 },
        compressTriggerPct: 0.6,
      },
    });
    const history = historyOf(ctx);
    expect(history.map((m) => m.content).join("\n")).not.toContain("ancient history");
    expect(ctx.rangesApplied).toEqual([]);
  });

  it("keeps restored actions subject to the history budget", () => {
    // Long actions (~50t each) under a 60t history cap: the restored
    // range's actions flow through the normal newest-first fill, so
    // only the newest survives.
    const long = storyActions(6).map((a) => ({ ...a, text: `${a.text} ${"y".repeat(190)}` }));
    const ctx = assembleContext({
      story: STORY,
      actions: long,
      cards: [],
      mode: "story",
      newInput: "next",
      tokenMultiplier: 1.0,
      ranges: [{ id: "r1", startIdx: 0, endIdx: 1, summary: "start" }],
      restoreRangeIds: ["r1"],
      budget: {
        totalTokens: 400,
        requiredCapPct: 0.7,
        dynamicSplit: { cards: 0.25, history: 0.5, memory: 0.25 },
        compressTriggerPct: 0.6,
      },
    });
    const history = historyOf(ctx);
    expect(history).toHaveLength(1);
    expect(history[0].content).toContain("action 5");
    expect(ctx.rangesApplied).toEqual([]);
  });
});
