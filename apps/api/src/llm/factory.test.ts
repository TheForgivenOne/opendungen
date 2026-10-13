import { describe, expect, it } from "vitest";
import { createProvider } from "./index";
import { ProviderError } from "./types";

describe("provider factory", () => {
  it("dispatches on kind", () => {
    expect(
      createProvider({ kind: "openai", baseUrl: null, model: "gpt-4o-mini", apiKey: "x" }).kind,
    ).toBe("openai");
    expect(
      createProvider({ kind: "anthropic", baseUrl: null, model: "claude-3-5-haiku", apiKey: "x" })
        .kind,
    ).toBe("anthropic");
    expect(
      createProvider({
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "llama3.2",
        apiKey: "",
      }).kind,
    ).toBe("ollama");
    expect(
      createProvider({
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080",
        model: "local",
        apiKey: "",
      }).kind,
    ).toBe("openai-compatible");
  });

  it("exposes the documented capability flags", () => {
    const openai = createProvider({ kind: "openai", baseUrl: null, model: "m", apiKey: "x" });
    expect(openai.supportsCaching).toBe(true);
    expect(openai.tokenMultiplier).toBe(1.0);
    const anthropic = createProvider({ kind: "anthropic", baseUrl: null, model: "m", apiKey: "x" });
    expect(anthropic.supportsCaching).toBe(true);
    const ollama = createProvider({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      apiKey: "",
    });
    expect(ollama.supportsCaching).toBe(false);
    const compat = createProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "m",
      apiKey: "",
    });
    expect(compat.supportsCaching).toBe(false);
  });

  it("rejects unknown kinds with a typed error", () => {
    expect(() =>
      createProvider({ kind: "mystery", baseUrl: null, model: "m", apiKey: "x" } as never),
    ).toThrowError(ProviderError);
  });

  it("rejects missing models and missing baseUrls", () => {
    expect(() =>
      createProvider({ kind: "openai", baseUrl: null, model: "", apiKey: "x" }),
    ).toThrowError(ProviderError);
    expect(() =>
      createProvider({ kind: "ollama", baseUrl: null, model: "m", apiKey: "" }),
    ).toThrowError(ProviderError);
    expect(() =>
      createProvider({ kind: "openai-compatible", baseUrl: null, model: "m", apiKey: "" }),
    ).toThrowError(ProviderError);
  });
});
