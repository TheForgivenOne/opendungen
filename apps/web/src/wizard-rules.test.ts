import { describe, expect, it } from "vitest";
import {
  WIZARD_KEY,
  markWizardDone,
  needsWizard,
  readWizardDone,
  shouldSkipWizard,
} from "./views/wizard";

describe("wizard rules", () => {
  it("skips when done, or in none-mode with a provider", () => {
    expect(shouldSkipWizard("single", 0, true)).toBe(true);
    expect(shouldSkipWizard("single", 5, true)).toBe(true);
    expect(shouldSkipWizard("none", 1, false)).toBe(true);
    expect(shouldSkipWizard("none", 0, false)).toBe(false);
    expect(shouldSkipWizard("single", 0, false)).toBe(false);
    expect(shouldSkipWizard("single", 3, false)).toBe(false);
  });

  it("needs the wizard for authenticated zero-provider users", () => {
    expect(needsWizard(true, 0, false)).toBe(true);
    expect(needsWizard(true, 1, false)).toBe(false);
    expect(needsWizard(true, null, false)).toBe(false);
    expect(needsWizard(true, 0, true)).toBe(false);
    expect(needsWizard(false, 0, false)).toBe(false);
  });

  it("tracks completion in localStorage", () => {
    window.localStorage.removeItem(WIZARD_KEY);
    expect(readWizardDone()).toBe(false);
    markWizardDone();
    expect(window.localStorage.getItem(WIZARD_KEY)).toBe("1");
    expect(readWizardDone()).toBe(true);
    window.localStorage.removeItem(WIZARD_KEY);
  });
});
