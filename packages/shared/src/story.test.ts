import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_MAX_OUTPUT_TOKENS, HISTORY_KEEP_LAST_N } from "./story";

describe("story model defaults", () => {
  it("uses the specified context budget", () => {
    expect(DEFAULT_CONTEXT_BUDGET.totalTokens).toBe(8192);
    expect(DEFAULT_CONTEXT_BUDGET.requiredCapPct).toBe(0.7);
    expect(DEFAULT_CONTEXT_BUDGET.dynamicSplit).toEqual({
      cards: 0.25,
      history: 0.5,
      memory: 0.25,
    });
    expect(DEFAULT_CONTEXT_BUDGET.compressTriggerPct).toBe(0.6);
  });

  it("uses the specified output and history constants", () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(400);
    expect(HISTORY_KEEP_LAST_N).toBe(3);
  });
});
