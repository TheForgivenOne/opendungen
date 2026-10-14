// Input mode rules: transformation cases shared with the
// server copy, plus localStorage persistence of the last-used mode.

import { describe, expect, it } from "vitest";
import {
  INPUT_MODE_KEY,
  applyInputMode,
  isInputMode,
  placeholderForMode,
  readStoredInputMode,
  storeInputMode,
} from "./input-mode";

describe("applyInputMode", () => {
  it("prefixes do inputs with 'You '", () => {
    expect(applyInputMode("open the door", "do")).toBe("You open the door");
  });
  it("passes You/I-led do inputs through", () => {
    expect(applyInputMode("You open the door", "do")).toBe("You open the door");
    expect(applyInputMode("you run", "do")).toBe("you run");
    expect(applyInputMode("I draw my sword", "do")).toBe("I draw my sword");
  });
  it("wraps say inputs in quotes unless quoted", () => {
    expect(applyInputMode("hello", "say")).toBe('"hello"');
    expect(applyInputMode('"hello"', "say")).toBe('"hello"');
  });
  it("passes story inputs through unchanged", () => {
    expect(applyInputMode("The dragon wakes.", "story")).toBe("The dragon wakes.");
  });
});

describe("input mode persistence", () => {
  it("defaults to do and round-trips through localStorage", () => {
    window.localStorage.clear();
    expect(readStoredInputMode()).toBe("do");
    storeInputMode("say");
    expect(readStoredInputMode()).toBe("say");
    // A reload reads the same key: still Say.
    expect(window.localStorage.getItem(INPUT_MODE_KEY)).toBe("say");
    expect(readStoredInputMode()).toBe("say");
    window.localStorage.clear();
  });

  it("ignores garbage in storage", () => {
    window.localStorage.setItem(INPUT_MODE_KEY, "shout");
    expect(readStoredInputMode()).toBe("do");
    expect(isInputMode("shout")).toBe(false);
    expect(isInputMode("do")).toBe(true);
    window.localStorage.clear();
  });

  it("has a distinct placeholder per mode", () => {
    expect(placeholderForMode("do")).toBe("What do you do?");
    expect(placeholderForMode("say")).toBe("What do you say?");
    expect(placeholderForMode("story")).toBe("What happens next?");
  });
});
