import { describe, expect, it } from "vitest";
import { formatHealth } from "./health";

describe("formatHealth", () => {
  it("renders the service status", () => {
    expect(formatHealth({ ok: true, service: "opendungen" })).toBe("opendungen: ok");
    expect(formatHealth({ ok: false, service: "opendungen" })).toBe("opendungen: not ok");
  });
});
