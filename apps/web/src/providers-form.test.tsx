// Provider form: model datalist from lazy listing, custom-headers
// textarea with blur validation, and the Advanced timeout inputs.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, click, getByText, queryByText, render, setInputValue } from "./test-utils";
import { EMPTY_PROVIDER_FORM, ProviderFields } from "./views/providers/ProviderFields";
import type { ProviderForm } from "./api/providers";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function Harness(props: {
  providerId?: string | null;
  storedHeadersHint?: boolean;
  initial?: ProviderForm;
}) {
  const [form, setForm] = useState<ProviderForm>(props.initial ?? EMPTY_PROVIDER_FORM);
  return (
    <ProviderFields
      form={form}
      onChange={setForm}
      apiKeyHint=""
      providerId={props.providerId}
      storedHeadersHint={props.storedHeadersHint}
    />
  );
}

function modelInput(container: ParentNode): HTMLInputElement {
  const el = container.querySelector('input[placeholder="llama3.2"]');
  if (!(el instanceof window.HTMLInputElement)) {
    throw new Error("model input not found");
  }
  return el;
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

describe("provider model datalist", () => {
  it("fetches the listing on first focus and renders options", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return json({ models: ["b-model", "a-model"], source: "listing" });
      }),
    );
    const { container, unmount } = render(<Harness providerId="prov-1" />);
    try {
      expect(container.querySelector("datalist")).toBeNull();
      act(() => {
        modelInput(container).focus();
      });
      await settled();
      expect(seen).toEqual(["/api/providers/prov-1/models"]);
      const list = container.querySelector("datalist");
      expect(list?.id).toBe("provider-model-options-prov-1");
      expect(modelInput(container).getAttribute("list")).toBe("provider-model-options-prov-1");
      const values = Array.from(list?.querySelectorAll("option") ?? []).map((o) =>
        o.getAttribute("value"),
      );
      expect(values).toEqual(["b-model", "a-model"]);

      // Second focus does not refetch.
      act(() => {
        modelInput(container).focus();
      });
      await settled();
      expect(seen).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("stays a plain input without a provider id or on listing failure", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return json({ error: { code: "listing_failed", message: "nope" } }, 502);
      }),
    );
    // Create form: no provider id, so no fetch at all.
    const fresh = render(<Harness providerId={null} />);
    try {
      act(() => {
        modelInput(fresh.container).focus();
      });
      await settled();
      expect(seen).toHaveLength(0);
      expect(fresh.container.querySelector("datalist")).toBeNull();
      expect(modelInput(fresh.container).getAttribute("list")).toBeNull();
    } finally {
      fresh.unmount();
    }

    // Edit form with a failing listing: plain input, no error UI.
    const edit = render(<Harness providerId="prov-9" />);
    try {
      act(() => {
        modelInput(edit.container).focus();
      });
      await settled();
      expect(seen).toEqual(["/api/providers/prov-9/models"]);
      expect(edit.container.querySelector("datalist")).toBeNull();
      expect(queryByText(edit.container, "nope")).toBeNull();
    } finally {
      edit.unmount();
    }
  });
});

describe("provider custom headers field", () => {
  function headersArea(container: ParentNode): HTMLTextAreaElement {
    const el = container.querySelector('textarea[placeholder=\'{"X-Team": "research"}\']');
    if (!(el instanceof window.HTMLTextAreaElement)) {
      throw new Error("headers textarea not found");
    }
    return el;
  }

  it("shows the textarea for openai-compatible kinds only", async () => {
    const ollama = render(<Harness />);
    try {
      expect(
        ollama.container.querySelector('textarea[placeholder=\'{"X-Team": "research"}\']'),
      ).toBeNull();
    } finally {
      ollama.unmount();
    }
    const compat = render(
      <ProviderFields
        form={{ ...EMPTY_PROVIDER_FORM, kind: "openai-compatible" }}
        onChange={() => {}}
        apiKeyHint=""
      />,
    );
    try {
      expect(headersArea(compat.container)).toBeTruthy();
    } finally {
      compat.unmount();
    }
  });

  it("validates JSON on blur with inline errors", async () => {
    const compat = render(
      <Harness initial={{ ...EMPTY_PROVIDER_FORM, kind: "openai-compatible" }} />,
    );
    try {
      const area = compat.container.querySelector(
        'textarea[placeholder=\'{"X-Team": "research"}\']',
      );
      if (!(area instanceof window.HTMLTextAreaElement)) {
        throw new Error("headers textarea not found");
      }
      setInputValue(area, "{oops");
      act(() => {
        area.focus();
      });
      act(() => {
        area.blur();
      });
      expect(getByText(compat.container, "Custom headers must be valid JSON.")).toBeTruthy();

      setInputValue(area, '{"Host": "evil"}');
      act(() => {
        area.focus();
      });
      act(() => {
        area.blur();
      });
      expect(getByText(compat.container, 'Header "Host" is reserved.')).toBeTruthy();

      setInputValue(area, '{"X-Team": "research"}');
      act(() => {
        area.focus();
      });
      act(() => {
        area.blur();
      });
      await settled();
      expect(queryByText(compat.container, "Custom headers must be valid JSON.")).toBeNull();
      expect(queryByText(compat.container, 'Header "Host" is reserved.')).toBeNull();
    } finally {
      compat.unmount();
    }
  });
});

describe("provider advanced timeouts", () => {
  it("reveals two numeric timeout inputs under Advanced", async () => {
    const { container, unmount } = render(<Harness />);
    try {
      expect(container.querySelector('input[placeholder="60000"]')).toBeNull();
      click(getByText(container, "Advanced +"));
      expect(container.querySelector('input[placeholder="60000"]')).toBeTruthy();
      expect(container.querySelector('input[placeholder="180000"]')).toBeTruthy();
    } finally {
      unmount();
    }
  });
});

describe("ollama local/cloud sub-mode", () => {
  function radios(container: ParentNode): HTMLInputElement[] {
    const els = Array.from(container.querySelectorAll('input[name="ollama-mode"]'));
    if (els.length !== 2) {
      throw new Error("expected the Local/Cloud radio group");
    }
    return els as HTMLInputElement[];
  }

  function baseUrlInput(container: ParentNode): HTMLInputElement {
    const el = container.querySelector('input[placeholder="http://localhost:11434"]');
    if (!(el instanceof window.HTMLInputElement)) {
      throw new Error("base URL input not found");
    }
    return el;
  }

  function keyInput(container: ParentNode): HTMLInputElement {
    const el = container.querySelector('input[type="password"]');
    if (!(el instanceof window.HTMLInputElement)) {
      throw new Error("key input not found");
    }
    return el;
  }

  function keyLabel(container: ParentNode): string {
    const label = keyInput(container).closest("label");
    if (!label) {
      throw new Error("key label not found");
    }
    return label.textContent ?? "";
  }

  it("defaults to Local with an editable base URL and optional key", async () => {
    const { container, unmount } = render(<Harness />);
    try {
      const [local, cloud] = radios(container);
      expect(local?.checked).toBe(true);
      expect(cloud?.checked).toBe(false);
      expect(baseUrlInput(container).value).toBe("http://localhost:11434");
      expect(baseUrlInput(container).readOnly).toBe(false);
      expect(keyInput(container).required).toBe(false);
      expect(keyLabel(container)).toContain("API key (optional)");
      expect(queryByText(container, "Get a key")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("switching to Cloud pins the base URL, requires the key, and links to keys", async () => {
    const { container, unmount } = render(<Harness />);
    try {
      const [, cloud] = radios(container);
      act(() => {
        cloud?.click();
      });
      await settled();
      const [localAfter, cloudAfter] = radios(container);
      expect(localAfter?.checked).toBe(false);
      expect(cloudAfter?.checked).toBe(true);
      expect(baseUrlInput(container).value).toBe("https://ollama.com");
      expect(baseUrlInput(container).readOnly).toBe(true);
      expect(keyInput(container).required).toBe(true);
      expect(keyLabel(container)).toContain("API key (required)");
      const link = getByText(container, "Get a key");
      expect(link.getAttribute("href")).toBe("https://ollama.com/settings/keys");

      // Switching back restores the editable local default.
      act(() => {
        localAfter?.click();
      });
      await settled();
      expect(baseUrlInput(container).value).toBe("http://localhost:11434");
      expect(baseUrlInput(container).readOnly).toBe(false);
      expect(keyLabel(container)).toContain("API key (optional)");
      expect(queryByText(container, "Get a key")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("a custom URL reflects as Local without locking the field", async () => {
    const { container, unmount } = render(<Harness />);
    try {
      setInputValue(baseUrlInput(container), "http://192.168.1.10:11434");
      await settled();
      const [local, cloud] = radios(container);
      expect(local?.checked).toBe(true);
      expect(cloud?.checked).toBe(false);
      expect(baseUrlInput(container).readOnly).toBe(false);
    } finally {
      unmount();
    }
  });

  it("shows no radio for other kinds", async () => {
    const { container, unmount } = render(
      <Harness initial={{ ...EMPTY_PROVIDER_FORM, kind: "openai" }} />,
    );
    try {
      expect(container.querySelectorAll('input[name="ollama-mode"]')).toHaveLength(0);
    } finally {
      unmount();
    }
  });
});
