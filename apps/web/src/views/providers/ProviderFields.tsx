// Provider form fields, shared by the providers screen and the
// first-run wizard (step 2 embeds the same form).

import { useEffect, useRef, useState } from "react";
import {
  PROVIDER_KINDS,
  isSuggestedProviderLabel,
  listModels,
  providerNeedsBaseUrl,
  suggestedProviderLabel,
  type ProviderForm,
  type ProviderKind,
} from "../../api/providers";
import { ghostClass, inputClass } from "../../ui";

export const EMPTY_PROVIDER_FORM: ProviderForm = {
  label: "Ollama (local)",
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  model: "",
  apiKey: "",
  customHeaders: "",
  ttftTimeoutMs: "",
  totalTimeoutMs: "",
};

// Cloud vs local is derived from the baseUrl at runtime (same rule as
// the server's isOllamaCloud): ollama.com hosts are the hosted
// service, anything else is a local-style server.
function isOllamaCloudUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/\.$/, "").toLowerCase();
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

// Client-side mirror of the server's custom-headers rules, for inline
// blur validation. The server re-validates on write.
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "authorization",
  "api-key",
  "x-api-key",
  "cookie",
]);

function validateHeadersText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "Custom headers must be valid JSON.";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Custom headers must be a JSON object.";
  }
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]+$/.test(key) || key.length > 40) {
      return `Invalid header name "${key}".`;
    }
    if (RESERVED_HEADERS.has(key.toLowerCase())) {
      return `Header "${key}" is reserved.`;
    }
    if (typeof value !== "string") {
      return `Value for "${key}" must be a string.`;
    }
    if (encoder.encode(value).length > 4096) {
      return `Value for "${key}" exceeds 4 KB.`;
    }
  }
  if (encoder.encode(JSON.stringify(parsed)).length > 8192) {
    return "Custom headers exceed 8 KB in total.";
  }
  return null;
}

export function ProviderFields({
  form,
  onChange,
  apiKeyHint,
  // Stored provider id when editing: the model datalist is fetched
  // lazily from its listing endpoint. Absent on the create form.
  providerId,
  // True when the stored provider has custom headers (the raw values
  // are never returned, so the textarea always starts empty on edit).
  storedHeadersHint,
  // Incremented by the parent to focus the Label field (the Providers
  // screen's Rename affordance opens the edit form at the label).
  labelFocusSignal,
}: {
  form: ProviderForm;
  onChange: (form: ProviderForm) => void;
  apiKeyHint: string;
  providerId?: string | null;
  storedHeadersHint?: boolean;
  labelFocusSignal?: number;
}) {
  // Model listing, keyed by provider: a fresh provider means a fresh
  // listing. The key check below adjusts state during render (the
  // documented pattern for derived state) rather than in an effect.
  const [modelCache, setModelCache] = useState<{
    forId: string | null | undefined;
    requested: boolean;
    options: string[] | null;
  }>({ forId: providerId, requested: false, options: null });
  if (modelCache.forId !== providerId) {
    setModelCache({ forId: providerId, requested: false, options: null });
  }
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const labelRef = useRef<HTMLInputElement | null>(null);

  // Rename affordance: focus the Label field when the signal changes.
  const lastFocusSignal = useRef(labelFocusSignal);
  useEffect(() => {
    if (labelFocusSignal !== undefined && labelFocusSignal !== lastFocusSignal.current) {
      lastFocusSignal.current = labelFocusSignal;
      labelRef.current?.focus();
      labelRef.current?.select();
    }
  }, [labelFocusSignal]);

  async function loadModelsOnce() {
    if (modelCache.requested || modelCache.forId !== providerId || !providerId) {
      return;
    }
    setModelCache({ forId: providerId, requested: true, options: null });
    try {
      const result = await listModels(providerId);
      // An empty list (or a failure) leaves a plain text input.
      if (result.models.length > 0) {
        setModelCache({ forId: providerId, requested: true, options: result.models });
      }
    } catch {
      // No error UI: the field stays a plain text input.
    }
  }
  const modelOptions = modelCache.forId === providerId ? modelCache.options : null;

  // Local vs Cloud for kind=ollama, derived from the baseUrl in both
  // directions: typing a custom URL simply reflects back as Local, and
  // the radio never locks the field (Cloud pins the hosted address).
  const ollamaMode =
    form.kind === "ollama" ? (isOllamaCloudUrl(form.baseUrl) ? "cloud" : "local") : null;

  function setKind(kind: ProviderKind) {
    // Keep a user-typed label; refresh an untouched (empty) or
    // auto-suggested label so it matches the new kind.
    const baseUrl =
      providerNeedsBaseUrl(kind) && !form.baseUrl
        ? kind === "ollama"
          ? "http://localhost:11434"
          : "http://127.0.0.1:11434"
        : form.baseUrl;
    const label =
      !form.label.trim() || isSuggestedProviderLabel(form.label)
        ? suggestedProviderLabel(kind, baseUrl)
        : form.label;
    onChange({ ...form, kind, baseUrl, label });
  }

  function setBaseUrl(baseUrl: string) {
    // Same suggestion rule for the ollama Local/Cloud switch: only
    // untouched or suggested labels follow the base URL.
    const label =
      form.kind === "ollama" && (!form.label.trim() || isSuggestedProviderLabel(form.label))
        ? suggestedProviderLabel(form.kind, baseUrl)
        : form.label;
    onChange({ ...form, baseUrl, label });
  }

  const datalistId = `provider-model-options-${providerId ?? "new"}`;

  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        Label
        <input
          ref={labelRef}
          className={`${inputClass} ${labelError ? "!border-danger" : ""}`}
          required
          aria-label="Label"
          aria-invalid={labelError !== null}
          value={form.label}
          onChange={(e) => {
            onChange({ ...form, label: e.target.value });
            if (labelError) {
              setLabelError(null);
            }
          }}
          onBlur={() => setLabelError(form.label.trim() ? null : "Label is required.")}
        />
      </label>
      {labelError && (
        <p role="alert" className="text-sm text-danger">
          {labelError}
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Kind
        <select
          className={inputClass}
          value={form.kind}
          onChange={(e) => setKind(e.target.value as ProviderKind)}
        >
          {PROVIDER_KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
      </label>
      {form.kind === "ollama" && (
        <div role="radiogroup" aria-label="Ollama server" className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="ollama-mode"
              checked={ollamaMode === "local"}
              onChange={() => setBaseUrl("http://localhost:11434")}
            />
            Local server
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="ollama-mode"
              checked={ollamaMode === "cloud"}
              onChange={() => setBaseUrl("https://ollama.com")}
            />
            Ollama Cloud
          </label>
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Base URL{providerNeedsBaseUrl(form.kind) ? " (required)" : " (optional)"}
        <input
          className={inputClass}
          placeholder="http://localhost:11434"
          value={form.baseUrl}
          readOnly={ollamaMode === "cloud"}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Model (required)
        <input
          className={inputClass}
          required
          placeholder="llama3.2"
          value={form.model}
          autoComplete="off"
          list={modelOptions ? datalistId : undefined}
          onFocus={() => void loadModelsOnce()}
          onChange={(e) => onChange({ ...form, model: e.target.value })}
        />
        {modelOptions && (
          <datalist id={datalistId}>
            {modelOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        API key
        {form.kind === "ollama"
          ? ollamaMode === "cloud"
            ? " (required)"
            : " (optional)"
          : apiKeyHint}
        <input
          className={inputClass}
          type="password"
          required={ollamaMode === "cloud"}
          value={form.apiKey}
          onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
        />
      </label>
      {ollamaMode === "cloud" && (
        <p className="text-xs text-text-muted">
          <a
            href="https://ollama.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Get a key
          </a>
        </p>
      )}
      {form.kind === "openai-compatible" && (
        <label className="flex flex-col gap-1 text-sm">
          Custom headers (JSON)
          <textarea
            className={`${inputClass} font-mono text-xs`}
            rows={3}
            placeholder='{"X-Team": "research"}'
            value={form.customHeaders}
            onChange={(e) => {
              onChange({ ...form, customHeaders: e.target.value });
              if (headersError) {
                setHeadersError(null);
              }
            }}
            onBlur={() => setHeadersError(validateHeadersText(form.customHeaders))}
          />
        </label>
      )}
      {form.kind === "openai-compatible" && storedHeadersHint && !form.customHeaders && (
        <p className="text-xs text-text-muted">
          Custom headers are stored on the server. Entering new JSON replaces them; clearing the
          field removes them.
        </p>
      )}
      {form.kind === "openai-compatible" && headersError && (
        <p role="alert" className="text-sm text-danger">
          {headersError}
        </p>
      )}
      <div>
        <button
          type="button"
          className={ghostClass}
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          Advanced {advancedOpen ? "−" : "+"}
        </button>
        {advancedOpen && (
          <div className="mt-2 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              TTFT timeout, ms (empty = 60000)
              <input
                className={inputClass}
                type="number"
                min={1000}
                max={600000}
                step={1000}
                placeholder="60000"
                value={form.ttftTimeoutMs}
                onChange={(e) => onChange({ ...form, ttftTimeoutMs: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Total timeout, ms (empty = 180000)
              <input
                className={inputClass}
                type="number"
                min={1000}
                max={600000}
                step={1000}
                placeholder="180000"
                value={form.totalTimeoutMs}
                onChange={(e) => onChange({ ...form, totalTimeoutMs: e.target.value })}
              />
            </label>
          </div>
        )}
      </div>
    </>
  );
}
