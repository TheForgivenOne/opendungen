// Providers screen (list + create/edit). The field block lives in
// ./ProviderFields.

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createProvider,
  deleteProvider,
  patchProvider,
  providerDisplayName,
  setDefaultProvider,
  testProvider,
  type Provider,
  type ProviderForm,
} from "../../api/providers";
import { errorMessage } from "../../api/client";
import { EMPTY_PROVIDER_FORM, ProviderFields } from "./ProviderFields";
import { useProviders } from "../../queries";
import { PageHeader } from "../../shell";
import { useToast } from "../../toast";
import { ErrorText, Skeleton, buttonClass, ghostClass } from "../../ui";

export function ProvidersScreen() {
  const client = useQueryClient();
  const toast = useToast();
  const providersQuery = useProviders();
  const [form, setForm] = useState<ProviderForm>(EMPTY_PROVIDER_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to focus the Label field when Rename opens the edit form.
  const [labelFocusSignal, setLabelFocusSignal] = useState(0);

  async function refresh() {
    await client.invalidateQueries({ queryKey: ["providers"] });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editing) {
        await patchProvider(editing, form);
        toast.push("success", "Provider saved.");
      } else {
        await createProvider(form);
        toast.push("success", "Provider added.");
      }
      setForm(EMPTY_PROVIDER_FORM);
      setEditing(null);
      setEditingProvider(null);
      await refresh();
    } catch (err) {
      // Network errors toast; the form keeps its state.
      toast.push("error", errorMessage(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(provider: Provider, focusLabel = false) {
    setEditing(provider.id);
    setEditingProvider(provider);
    setForm({
      label: provider.label,
      kind: provider.kind,
      baseUrl: provider.baseUrl ?? "",
      model: provider.model,
      apiKey: "",
      // Raw headers are never returned; the textarea starts empty.
      customHeaders: "",
      ttftTimeoutMs: provider.ttftTimeoutMs?.toString() ?? "",
      totalTimeoutMs: provider.totalTimeoutMs?.toString() ?? "",
    });
    if (focusLabel) {
      setLabelFocusSignal((n) => n + 1);
    }
  }

  async function runTest(id: string) {
    setTestResults((prev) => ({ ...prev, [id]: "testing…" }));
    try {
      const result = await testProvider(id);
      setTestResults((prev) => ({
        ...prev,
        [id]: result.ok ? `ok: ${result.model}` : `failed: ${result.error}`,
      }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [id]: `failed: ${errorMessage(err)}` }));
    }
    await refresh();
  }

  async function makeDefault(id: string) {
    setError(null);
    try {
      await setDefaultProvider(id);
      await refresh();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deleteProvider(id);
      if (editing === id) {
        setEditing(null);
        setEditingProvider(null);
        setForm(EMPTY_PROVIDER_FORM);
      }
      await refresh();
      toast.push("success", "Provider deleted.");
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  const providers = providersQuery.data?.providers ?? null;

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <PageHeader title="Providers" />
      <p className="mb-4 text-sm text-text-muted">
        Bring your own LLM. Keys are encrypted on the server and never shown again.
      </p>
      <ErrorText error={error} />
      {providersQuery.isPending ? (
        <Skeleton lines={2} />
      ) : providersQuery.isError ? (
        <ErrorText error={errorMessage(providersQuery.error)} />
      ) : providers !== null && providers.length === 0 ? (
        <p className="mb-4 text-text-muted">No providers yet.</p>
      ) : (
        <ul className="mb-6 flex flex-col gap-2">
          {(providers ?? []).map((provider) => {
            // Flag labels that are empty or identical to the model:
            // same-model providers are otherwise indistinguishable.
            const needsRename = !provider.label.trim() || provider.label === provider.model;
            return (
              <li key={provider.id} className="rounded border border-border bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">
                      {providerDisplayName(provider) || "Unnamed provider"}
                    </span>{" "}
                    <span className="text-sm text-text-muted">{provider.kind}</span>{" "}
                    {provider.isDefault && (
                      <span className="rounded bg-accent/10 px-2 py-0.5 text-xs text-accent">
                        default
                      </span>
                    )}
                    {needsRename && (
                      <button
                        className="ml-2 font-mono text-xs text-accent hover:underline"
                        onClick={() => startEdit(provider, true)}
                      >
                        Rename
                      </button>
                    )}
                    <div className="text-xs text-text-muted">
                      {provider.hasKey ? "key stored" : "no key stored"}
                      {provider.hasCustomHeaders ? " · custom headers" : ""}
                      {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
                    </div>
                  </div>
                </div>
                {testResults[provider.id] && (
                  <p className="mt-1 text-sm">{testResults[provider.id]}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className={ghostClass} onClick={() => void runTest(provider.id)}>
                    Test
                  </button>
                  {!provider.isDefault && (
                    <button className={ghostClass} onClick={() => void makeDefault(provider.id)}>
                      Set default
                    </button>
                  )}
                  <button className={ghostClass} onClick={() => startEdit(provider)}>
                    Edit
                  </button>
                  <button className={ghostClass} onClick={() => void remove(provider.id)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <h2 className="mb-2 font-bold">{editing ? "Edit provider" : "Add provider"}</h2>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <ProviderFields
          form={form}
          onChange={setForm}
          apiKeyHint={editing ? " (empty = unchanged)" : " (empty for keyless local servers)"}
          providerId={editing}
          storedHeadersHint={editingProvider?.hasCustomHeaders ?? false}
          labelFocusSignal={labelFocusSignal}
        />
        <div className="flex gap-2">
          <button className={buttonClass} disabled={busy}>
            {editing ? "Save" : "Add"}
          </button>
          {editing && (
            <button
              type="button"
              className={ghostClass}
              onClick={() => {
                setEditing(null);
                setEditingProvider(null);
                setForm(EMPTY_PROVIDER_FORM);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
