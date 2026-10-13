// Provider display names (label shown only when it
// differs from the model), the required-label inline validation with
// kind-based suggestions, and the Rename affordance.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./toast";
import { act, click, getByText, queryByText, render } from "./test-utils";
import { providerDisplayName, suggestedProviderLabel, type ProviderForm } from "./api/providers";
import { EMPTY_PROVIDER_FORM, ProviderFields } from "./views/providers/ProviderFields";
import { ProvidersScreen } from "./views/providers/ProvidersScreen";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function settled(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providerDisplayName", () => {
  it("shows only the model when label === model", () => {
    expect(providerDisplayName({ label: "gpt-oss:20b", model: "gpt-oss:20b" })).toBe("gpt-oss:20b");
  });

  it("shows label and model when they differ", () => {
    expect(providerDisplayName({ label: "Local", model: "gpt-oss:20b" })).toBe(
      "Local · gpt-oss:20b",
    );
  });

  it("falls back to the model when the label is empty", () => {
    expect(providerDisplayName({ label: "", model: "gpt-oss:20b" })).toBe("gpt-oss:20b");
    expect(providerDisplayName({ label: "   ", model: "gpt-oss:20b" })).toBe("gpt-oss:20b");
  });

  it("shows nothing when both are empty", () => {
    expect(providerDisplayName({ label: "", model: "" })).toBe("");
  });
});

describe("suggestedProviderLabel", () => {
  it("suggests per kind and ollama mode", () => {
    expect(suggestedProviderLabel("ollama", "http://localhost:11434")).toBe("Ollama (local)");
    expect(suggestedProviderLabel("ollama", "https://ollama.com")).toBe("Ollama Cloud");
    expect(suggestedProviderLabel("openai", "")).toBe("OpenAI");
    expect(suggestedProviderLabel("anthropic", "")).toBe("Anthropic");
    expect(suggestedProviderLabel("openai-compatible", "http://x")).toBe("Custom endpoint");
  });
});

describe("provider label field", () => {
  function Harness({ initial }: { initial?: ProviderForm }) {
    const [form, setForm] = useState<ProviderForm>(initial ?? EMPTY_PROVIDER_FORM);
    return <ProviderFields form={form} onChange={setForm} apiKeyHint="" />;
  }

  function labelInput(container: ParentNode): HTMLInputElement {
    const el = container.querySelector('input[aria-label="Label"]');
    if (!(el instanceof window.HTMLInputElement)) {
      throw new Error("label input not found");
    }
    return el;
  }

  it("pre-fills the suggested default label", () => {
    const { container, unmount } = render(<Harness />);
    try {
      expect(labelInput(container).value).toBe("Ollama (local)");
    } finally {
      unmount();
    }
  });

  it("flags an empty label on blur with red border and error text", async () => {
    const { container, unmount } = render(
      <Harness initial={{ ...EMPTY_PROVIDER_FORM, label: "" }} />,
    );
    try {
      const input = labelInput(container);
      expect(queryByText(container, "Label is required.")).toBeNull();
      act(() => {
        input.focus();
      });
      act(() => {
        input.blur();
      });
      getByText(container, "Label is required.");
      expect(input.className).toContain("border-danger");
    } finally {
      unmount();
    }
  });
});

describe("providers screen rename affordance", () => {
  function provider(id: string, label: string, model: string) {
    return {
      id,
      userId: "u1",
      label,
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model,
      hasKey: false,
      isDefault: id === "same",
      createdAt: 1,
      hasCustomHeaders: false,
      ttftTimeoutMs: null,
      totalTimeoutMs: null,
    };
  }

  function mountScreen() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/providers") {
          return json({
            providers: [
              provider("same", "gpt-oss:20b", "gpt-oss:20b"),
              provider("distinct", "Local workhorse", "gpt-oss:20b"),
            ],
          });
        }
        return json({ error: { code: "not_found", message: "no mock" } }, 404);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ProvidersScreen />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it("shows the model once and flags the same-label provider with Rename", async () => {
    const { container, unmount } = mountScreen();
    try {
      await settled();
      // No duplicated badge anywhere.
      expect(container.textContent).not.toContain("gpt-oss:20b · gpt-oss:20b");
      // The distinct provider renders its label + model.
      getByText(container, "Local workhorse · gpt-oss:20b");
      // Exactly one Rename affordance: on the same-label row.
      const renames = Array.from(container.querySelectorAll("button")).filter(
        (b) => b.textContent === "Rename",
      );
      expect(renames).toHaveLength(1);
      // Rename opens the edit form focused on the Label field.
      click(renames[0]!);
      await settled();
      getByText(container, "Edit provider");
      const active = document.activeElement;
      if (!(active instanceof window.HTMLInputElement)) {
        throw new Error("label field was not focused");
      }
      expect(active.getAttribute("aria-label")).toBe("Label");
      (document.activeElement as HTMLElement | null)?.blur?.();
    } finally {
      unmount();
    }
  });
});
