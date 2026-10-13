import { describe, expect, it } from "vitest";
import { historyNext, historyPrev } from "./input-history";

describe("input history", () => {
  const inputs = ["open the door", "go north", "take the lamp"];

  it("Ctrl+Up populates the textarea with the previous input", () => {
    const { text, cursor } = historyPrev(inputs, null, "");
    expect(text).toBe("take the lamp");
    expect(cursor).toEqual({ saved: "", index: 2 });
  });

  it("Ctrl+Up twice goes back two inputs", () => {
    const first = historyPrev(inputs, null, "");
    const second = historyPrev(inputs, first.cursor, first.text);
    expect(second.text).toBe("go north");
    expect(second.cursor).toEqual({ saved: "", index: 1 });
  });

  it("Ctrl+Down returns to newer inputs", () => {
    const first = historyPrev(inputs, null, "");
    const second = historyPrev(inputs, first.cursor, first.text);
    const back = historyNext(inputs, second.cursor);
    expect(back.text).toBe("take the lamp");
    expect(back.cursor).toEqual({ saved: "", index: 2 });
  });

  it("restores in-progress text when reaching the end", () => {
    const first = historyPrev(inputs, null, "half-typed");
    const end = historyNext(inputs, first.cursor);
    expect(end.text).toBe("half-typed");
    expect(end.cursor).toBeNull();
  });

  it("clamps at the oldest input and ignores Down while browsing off", () => {
    let state = historyPrev(inputs, null, "");
    state = historyPrev(inputs, state.cursor, state.text);
    state = historyPrev(inputs, state.cursor, state.text);
    state = historyPrev(inputs, state.cursor, state.text);
    expect(state.text).toBe("open the door");
    expect(state.cursor).toEqual({ saved: "", index: 0 });
    expect(historyNext(inputs, null)).toEqual({ text: null, cursor: null });
  });

  it("handles an empty history", () => {
    expect(historyPrev([], null, "typing")).toEqual({
      text: "typing",
      cursor: { saved: "typing", index: 0 },
    });
  });
});
