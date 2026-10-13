import { describe, expect, it } from "vitest";
import { bootTargetFor } from "./boot";

describe("boot routing", () => {
  const setup = { mode: "single", needsSetup: true, authenticated: false };
  const loggedOut = { mode: "single", needsSetup: false, authenticated: false };
  const authed = { mode: "single", needsSetup: false, authenticated: true };
  const noneAuthed = { mode: "none", needsSetup: false, authenticated: true };

  it("forces setup and login (auth-required redirect)", () => {
    expect(bootTargetFor(setup, null, false, "/stories", false, false)).toBe("/setup");
    expect(bootTargetFor(setup, null, false, "/setup", false, false)).toBeNull();
    expect(bootTargetFor(loggedOut, null, false, "/stories", false, false)).toBe("/login");
    expect(bootTargetFor(loggedOut, null, false, "/login", false, false)).toBeNull();
  });

  it("pushes authenticated users out of auth screens", () => {
    expect(bootTargetFor(authed, 1, true, "/login", true, false)).toBe("/");
    expect(bootTargetFor(authed, 1, true, "/setup", true, false)).toBe("/");
  });

  it("returns authenticated users to their pre-login route", () => {
    expect(bootTargetFor(authed, 1, true, "/login", true, false, "/stories/abc")).toBe(
      "/stories/abc",
    );
    expect(bootTargetFor(authed, 1, true, "/setup", true, false, "/scenarios")).toBe("/scenarios");
  });

  it("sends zero-provider users to the wizard", () => {
    expect(bootTargetFor(authed, 0, false, "/stories", false, true)).toBe("/wizard/step-1");
    expect(bootTargetFor(authed, 0, false, "/wizard/step-2", false, true)).toBeNull();
    expect(bootTargetFor(authed, 1, false, "/stories", false, false)).toBeNull();
  });

  it("bounces out of the wizard when it is skipped", () => {
    expect(bootTargetFor(authed, 1, true, "/wizard/step-1", true, false)).toBe("/");
    expect(bootTargetFor(noneAuthed, 2, false, "/wizard/step-1", true, false)).toBe("/");
  });

  it("stays mid-wizard while the provider count changes", () => {
    // Saving the step-2 provider flips needsWizardNow off; the user is
    // still working through the wizard and must not be bounced.
    expect(bootTargetFor(authed, 1, false, "/wizard/step-2", false, false)).toBeNull();
  });

  it("waits (stays) while the provider count loads", () => {
    expect(bootTargetFor(authed, null, false, "/stories", false, false)).toBeNull();
  });

  it("leaves the root to the auto-resume view", () => {
    expect(bootTargetFor(authed, 1, true, "/", true, false)).toBeNull();
  });
});
