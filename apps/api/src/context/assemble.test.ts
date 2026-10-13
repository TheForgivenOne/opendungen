import { describe, expect, it } from "vitest";
import {
  assembleContext,
  cardMatches,
  estimateTokens,
  selectTriggeredCards,
  type AssembledContext,
  type AssembleAction,
  type AssembleCards,
  type AssembleStory,
} from "./assemble";
import { BASE_SYSTEM_PROMPT, MODE_DIRECTIVES, OUTPUT_CONSTRAINTS } from "./prompts";

const STORY: AssembleStory = {
  aiInstructions: "You narrate dark fantasy.",
  plotEssentials: "The lantern must stay lit.",
  summary: "A traveler reached the waystation.",
  memory: "The innkeeper fears wolves.",
};

const ACTIONS: AssembleAction[] = [
  { idx: 0, type: "input", text: "I enter the hall." },
  { idx: 1, type: "output", text: "The hall smells of smoke." },
  { idx: 2, type: "input", text: "I draw my sword near the dragon mural." },
];

function cards(): AssembleCards[] {
  return [
    { id: "c1", keys: ["dragon"], entry: "Dragons fear bells.", enabled: true },
    { id: "c2", keys: ["lantern"], entry: "The lantern never gutters.", enabled: true },
    { id: "c3", keys: ["wolf"], entry: "Wolves hunt at dusk.", enabled: false },
  ];
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

describe("card matching", () => {
  it("matches case-insensitively on whole words", () => {
    expect(cardMatches(["dragon"], "A DRAGON lands.")).toBe(true);
    expect(cardMatches(["dragon"], "I see dragons.")).toBe(false);
    expect(cardMatches(["dragon"], "Snapdragon tea.")).toBe(false);
  });

  it("matches any of several keys", () => {
    expect(cardMatches(["wolf", "lantern"], "Light the lantern.")).toBe(true);
    expect(cardMatches(["wolf", "lantern"], "Light the room.")).toBe(false);
  });
});

describe("card selection", () => {
  it("triggers on the last 3 actions plus the new input", () => {
    // "dragon" appears in action idx 2 (within the last 3).
    expect(selectTriggeredCards(cards(), ACTIONS, "I wait.").map((c) => c.id)).toEqual(["c1"]);
    // A key only in the new input also triggers.
    expect(
      selectTriggeredCards(cards(), ACTIONS, "Trim the lantern wick.").map((c) => c.id),
    ).toEqual(["c1", "c2"]);
  });

  it("skips disabled cards", () => {
    const withWolf: AssembleAction[] = [{ idx: 3, type: "input", text: "A wolf howls." }];
    expect(selectTriggeredCards(cards(), withWolf, "I wait.").map((c) => c.id)).toEqual([]);
  });

  it("caps injected cards at 5", () => {
    const many: AssembleCards[] = Array.from({ length: 7 }, (_, i) => ({
      id: `k${i}`,
      keys: ["hall"],
      entry: `entry ${i}`,
      enabled: true,
    }));
    expect(selectTriggeredCards(many, ACTIONS, "I wait.")).toHaveLength(5);
  });
});

describe("message order", () => {
  it("ships layered systems, history oldest-first, then the new input", () => {
    const ctx = assembleContext({
      story: STORY,
      actions: ACTIONS,
      cards: cards(),
      mode: "do",
      newInput: "I ring the bell.",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    const roles = ctx.messages.map((m) => m.role);
    // 7 stable systems (base, constraints, scenario, mode, plot,
    // summary, lore) + 3 history + note + input.
    expect(roles).toEqual([
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "user",
      "system",
      "user",
    ]);
    const history = ctx.messages.slice(7, 10);
    expect(history.map((m) => m.content)).toEqual(ACTIONS.map((a) => a.text));
    // do-mode input is marked with "> ".
    expect(ctx.messages[ctx.messages.length - 1]).toMatchObject({
      role: "user",
      content: "> I ring the bell.",
    });
    // The dragon card fired into the World Lore layer.
    expect(ctx.messages[6].content).toContain("World Lore:");
    expect(ctx.messages[6].content).toContain("Dragons fear bells.");
    expect(ctx.cardsInjected).toEqual(["c1"]);
    expect(ctx.cachePrefixUpTo).toBe(6);
    expect(ctx.maxTokens).toBe(400);
  });

  it("maps continue actions to assistant", () => {
    const ctx = assembleContext({
      story: { aiInstructions: "", plotEssentials: "", summary: "", memory: "" },
      actions: [{ idx: 0, type: "continue", text: "The tale continues." }],
      cards: [],
      mode: "story",
      newInput: "Go on.",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    expect(ctx.messages.map((m) => m.role)).toEqual([
      "system",
      "system",
      "system",
      "assistant",
      "user",
    ]);
  });
});

describe("prompt layers", () => {
  const empty = { aiInstructions: "", plotEssentials: "", summary: "", memory: "" };

  it("always sends base + constraints as the first two messages", () => {
    for (const mode of ["do", "say", "story", "continue"] as const) {
      const ctx = assembleContext({
        story: { ...empty, aiInstructions: "scene rules", memory: "keep it grim" },
        actions: [],
        cards: [],
        mode,
        ...(mode === "continue" ? {} : { newInput: "hi" }),
        tokenMultiplier: 1.0,
        ranges: [],
      });
      expect(ctx.messages[0]).toMatchObject({ role: "system", content: BASE_SYSTEM_PROMPT });
      expect(ctx.messages[1]).toMatchObject({ role: "system", content: OUTPUT_CONSTRAINTS });
    }
  });

  it("inserts scenario instructions third when non-empty", () => {
    const ctx = assembleContext({
      story: { ...empty, aiInstructions: "grim rules" },
      actions: [],
      cards: [],
      mode: "do",
      newInput: "hi",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    expect(ctx.messages[2]).toMatchObject({ role: "system", content: "grim rules" });
    expect(ctx.messages[3].content).toBe(MODE_DIRECTIVES.do);
  });

  it("omits the scenario layer when empty", () => {
    const ctx = assembleContext({
      story: empty,
      actions: [],
      cards: [],
      mode: "say",
      newInput: "hi",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    expect(ctx.messages[2]).toMatchObject({ role: "system", content: MODE_DIRECTIVES.say });
  });

  it("selects the mode directive per mode", () => {
    for (const mode of ["do", "say", "story", "continue"] as const) {
      const ctx = assembleContext({
        story: empty,
        actions: [],
        cards: [],
        mode,
        tokenMultiplier: 1.0,
        ranges: [],
      });
      const directives = ctx.messages.filter((m) => m.role === "system").map((m) => m.content);
      expect(directives).toContain(MODE_DIRECTIVES[mode]);
    }
  });

  it("places the Author's Note after history and before the input", () => {
    const ctx = assembleContext({
      story: { ...empty, memory: "the vault is open" },
      actions: [{ idx: 0, type: "output", text: "Dust falls." }],
      cards: [],
      mode: "do",
      newInput: "I enter.",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    const tail = ctx.messages.slice(-3);
    expect(tail.map((m) => m.role)).toEqual(["assistant", "system", "user"]);
    expect(tail[0].content).toBe("Dust falls.");
    expect(tail[1].content).toBe("Author's Note: [the vault is open]");
    expect(tail[2].content).toBe("> I enter.");
  });

  it("omits the Author's Note when memory is empty", () => {
    const ctx = assembleContext({
      story: empty,
      actions: [{ idx: 0, type: "output", text: "Dust falls." }],
      cards: [],
      mode: "do",
      newInput: "I enter.",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    expect(ctx.messages.some((m) => m.content.includes("Author's Note"))).toBe(false);
  });

  it("omits the final user message in continue mode", () => {
    const ctx = assembleContext({
      story: { ...empty, memory: "raise the stakes" },
      actions: [{ idx: 0, type: "output", text: "The door creaks." }],
      cards: [],
      mode: "continue",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    const last = ctx.messages[ctx.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("The door creaks.");
    expect(ctx.messages.filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("formats do/say inputs with '> ' and story inputs raw", () => {
    for (const [mode, expected] of [
      ["do", "> You look."],
      ["say", '> "Who goes?"'],
      ["story", "The lantern gutters."],
    ] as const) {
      const text = expected.startsWith("> ") ? expected.slice(2) : expected;
      const ctx = assembleContext({
        story: empty,
        actions: [],
        cards: [],
        mode,
        newInput: text,
        tokenMultiplier: 1.0,
        ranges: [],
      });
      expect(ctx.messages[ctx.messages.length - 1]).toMatchObject({
        role: "user",
        content: expected,
      });
    }
  });

  it("points cachePrefixUpTo at the last stable system message", () => {
    // Full layers: the World Lore message is the last stable system.
    const full = assembleContext({
      story: STORY,
      actions: [],
      cards: cards(),
      mode: "do",
      newInput: "dragon",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    const loreIdx = full.messages.findIndex((m) => m.content.startsWith("World Lore:"));
    expect(loreIdx).toBeGreaterThan(0);
    expect(full.cachePrefixUpTo).toBe(loreIdx);
    // Bare story: base, constraints, mode directive only.
    const bare = assembleContext({
      story: empty,
      actions: [],
      cards: [],
      mode: "story",
      tokenMultiplier: 1.0,
      ranges: [],
    });
    expect(bare.messages).toHaveLength(3);
    expect(bare.cachePrefixUpTo).toBe(2);
  });
});

describe("budgets", () => {
  it("trims cards, then memory, then plot — never base, constraints, scenario, or mode", () => {
    const ctx = assembleContext({
      story: {
        aiInstructions: "i".repeat(100),
        plotEssentials: "p".repeat(200),
        summary: "s".repeat(40),
        memory: "m".repeat(2000),
      },
      actions: [],
      cards: [],
      mode: "do",
      newInput: "hi",
      tokenMultiplier: 1.0,
      ranges: [],
      budget: {
        totalTokens: 400,
        requiredCapPct: 0.7,
        dynamicSplit: { cards: 0.25, history: 0.5, memory: 0.25 },
        compressTriggerPct: 0.6,
      },
    });
    const systems = ctx.messages.filter((m) => m.role === "system").map((m) => m.content);
    const joined = systems.join("\n");
    // Memory (the overflow) and plot are trimmed away...
    expect(joined).not.toContain("m".repeat(100));
    expect(joined).not.toContain("p".repeat(100));
    // ...but the fixed layers survive intact: base, constraints,
    // scenario instructions, mode directive, and the short summary.
    expect(systems[0]).toBe(BASE_SYSTEM_PROMPT);
    expect(systems[1]).toBe(OUTPUT_CONSTRAINTS);
    expect(joined).toContain("i".repeat(100));
    expect(joined).toContain(MODE_DIRECTIVES.do);
    expect(joined).toContain("s".repeat(40));
  });

  it("never trims the story summary below 100 tokens", () => {
    const ctx = assembleContext({
      story: {
        aiInstructions: "i".repeat(4000),
        plotEssentials: "p".repeat(4000),
        summary: "s".repeat(800),
        memory: "m".repeat(4000),
      },
      actions: [],
      cards: [],
      mode: "do",
      newInput: "hi",
      tokenMultiplier: 1.0,
      ranges: [],
      budget: {
        totalTokens: 200,
        requiredCapPct: 0.7,
        dynamicSplit: { cards: 0.25, history: 0.5, memory: 0.25 },
        compressTriggerPct: 0.6,
      },
    });
    const systems = ctx.messages.filter((m) => m.role === "system").map((m) => m.content);
    const joined = systems.join("\n");
    // Plot and memory trim away; scenario instructions are fixed.
    expect(joined).not.toContain("p".repeat(100));
    expect(joined).not.toContain("m".repeat(100));
    expect(joined).toContain("i".repeat(100));
    expect(systems[0]).toBe(BASE_SYSTEM_PROMPT);
    expect(systems[1]).toBe(OUTPUT_CONSTRAINTS);
    expect(joined).toContain(MODE_DIRECTIVES.do);
    const summaryText = joined.slice(joined.indexOf("Story Summary"));
    expect(estimateTokens(summaryText.length, 1.0)).toBeGreaterThanOrEqual(100);
  });

  it("caps history to its dynamic share, newest first, but never trims the last action", () => {
    const many: AssembleAction[] = Array.from({ length: 20 }, (_, i) => ({
      idx: i,
      type: i % 2 === 0 ? "input" : "output",
      text: `action number ${i} with enough words to cost tokens ${"x".repeat(60)}`,
    }));
    // Tight budget: history cap = 50% of 30% of 400 = 60 tokens;
    // each action ~28t, so only the 2 newest fit.
    const tight = assembleContext({
      story: { aiInstructions: "", plotEssentials: "", summary: "", memory: "" },
      actions: many,
      cards: [],
      mode: "story",
      newInput: "next",
      tokenMultiplier: 1.0,
      ranges: [],
      budget: {
        totalTokens: 400,
        requiredCapPct: 0.7,
        dynamicSplit: { cards: 0.25, history: 0.5, memory: 0.25 },
        compressTriggerPct: 0.6,
      },
    });
    const history = historyOf(tight);
    expect(history).toHaveLength(2);
    expect(history[0].content).toContain("action number 18");
    expect(history[1].content).toContain("action number 19");
    expect(tight.usage.history).toBeLessThanOrEqual(60);
    expect(tight.usage.total).toBeLessThanOrEqual(400);

    // One action larger than the whole history cap still ships: the
    // last action is never trimmed.
    const lone = assembleContext({
      story: { aiInstructions: "", plotEssentials: "", summary: "", memory: "" },
      actions: [{ idx: 0, type: "output", text: `only action ${"y".repeat(300)}` }],
      cards: [],
      mode: "story",
      newInput: "next",
      tokenMultiplier: 1.0,
      ranges: [],
      budget: {
        totalTokens: 400,
        requiredCapPct: 0.7,
        dynamicSplit: { cards: 0.25, history: 0.5, memory: 0.25 },
        compressTriggerPct: 0.6,
      },
    });
    expect(historyOf(lone)).toHaveLength(1);
  });

  it("reports usage with the documented shape", () => {
    const newInput = "I ring the bell.";
    const ctx = assembleContext({
      story: STORY,
      actions: ACTIONS,
      cards: cards(),
      mode: "do",
      newInput,
      tokenMultiplier: 1.0,
      ranges: [],
    });
    expect(Object.keys(ctx.usage).sort()).toEqual(["cards", "history", "required", "total"]);
    // Total counts the sent messages (section headers, the "> "
    // marker, the Author's Note wrapper) on top of the layer
    // components; the overhead stays small.
    const floor =
      ctx.usage.required +
      ctx.usage.cards +
      ctx.usage.history +
      estimateTokens(`> ${newInput}`.length, 1.0);
    expect(ctx.usage.total).toBeGreaterThanOrEqual(floor);
    expect(ctx.usage.total).toBeLessThanOrEqual(floor + 30);
  });
});
