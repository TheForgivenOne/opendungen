// Story settings drawer panels: advanced overrides, provider,
// narrative layers, and story management.

import { useState, type FormEvent } from "react";
import { type Story, type StorySettingsPatch } from "../../api/stories";
import { providerDisplayName, type Provider } from "../../api/providers";
import { navigate } from "../../location";
import { useDeleteStory, useSaveStory } from "../../queries";
import { buttonClass, ghostClass, inputClass } from "../../ui";

// Phase 4 advanced settings: nullable per-story overrides. Effective
// values fall back to the shared constants; null resets to defaults.
// Must match packages/shared/src/story.ts + context/compress.ts.
export const EFFECTIVE_DEFAULTS = {
  contextTokens: 8192,
  maxOutputTokens: 400,
  compressTriggerPct: 0.6,
  compressMaxTokens: 600,
  compressTemperature: 0.2,
};

export function AdvancedPanel({ story }: { story: Story }) {
  const saveStory = useSaveStory(story.id);
  const [contextTokens, setContextTokens] = useState(story.contextTokens?.toString() ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(story.maxOutputTokens?.toString() ?? "");
  const [compressTriggerPct, setCompressTriggerPct] = useState(
    story.compressTriggerPct?.toString() ?? "",
  );
  const [compressMaxTokens, setCompressMaxTokens] = useState(
    story.compressMaxTokens?.toString() ?? "",
  );
  const [compressTemperature, setCompressTemperature] = useState(
    story.compressTemperature?.toString() ?? "",
  );

  function parseIntOrNull(text: string): number | null {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    const value = Number.parseInt(trimmed, 10);
    return Number.isNaN(value) ? null : value;
  }

  function parseFloatOrNull(text: string): number | null {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    const value = Number.parseFloat(trimmed);
    return Number.isNaN(value) ? null : value;
  }

  function save(e: FormEvent) {
    e.preventDefault();
    saveStory.mutate({
      contextTokens: parseIntOrNull(contextTokens),
      maxOutputTokens: parseIntOrNull(maxOutputTokens),
      compressTriggerPct: parseFloatOrNull(compressTriggerPct),
      compressMaxTokens: parseIntOrNull(compressMaxTokens),
      compressTemperature: parseFloatOrNull(compressTemperature),
    });
  }

  function resetAll() {
    setContextTokens("");
    setMaxOutputTokens("");
    setCompressTriggerPct("");
    setCompressMaxTokens("");
    setCompressTemperature("");
    saveStory.mutate({
      contextTokens: null,
      maxOutputTokens: null,
      compressTriggerPct: null,
      compressMaxTokens: null,
      compressTemperature: null,
    });
  }

  const fields: {
    key: string;
    label: string;
    value: string;
    setValue: (v: string) => void;
    effective: number;
    min: string;
    max: string;
    step: string;
  }[] = [
    {
      key: "contextTokens",
      label: "Context tokens",
      value: contextTokens,
      setValue: setContextTokens,
      effective: story.contextTokens ?? EFFECTIVE_DEFAULTS.contextTokens,
      min: "2048",
      max: "200000",
      step: "1",
    },
    {
      key: "maxOutputTokens",
      label: "Max output tokens",
      value: maxOutputTokens,
      setValue: setMaxOutputTokens,
      effective: story.maxOutputTokens ?? EFFECTIVE_DEFAULTS.maxOutputTokens,
      min: "100",
      max: "4000",
      step: "1",
    },
    {
      key: "compressTriggerPct",
      label: "Compress trigger",
      value: compressTriggerPct,
      setValue: setCompressTriggerPct,
      effective: story.compressTriggerPct ?? EFFECTIVE_DEFAULTS.compressTriggerPct,
      min: "0.3",
      max: "0.95",
      step: "0.05",
    },
    {
      key: "compressMaxTokens",
      label: "Compressor max tokens",
      value: compressMaxTokens,
      setValue: setCompressMaxTokens,
      effective: story.compressMaxTokens ?? EFFECTIVE_DEFAULTS.compressMaxTokens,
      min: "200",
      max: "2000",
      step: "1",
    },
    {
      key: "compressTemperature",
      label: "Compressor temperature",
      value: compressTemperature,
      setValue: setCompressTemperature,
      effective: story.compressTemperature ?? EFFECTIVE_DEFAULTS.compressTemperature,
      min: "0",
      max: "1",
      step: "0.05",
    },
  ];

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center justify-between">
              <span>
                {field.label}{" "}
                <span className="text-text-muted">(effective: {field.effective})</span>
              </span>
              <button
                type="button"
                className="font-mono text-xs text-text-muted hover:text-text"
                title={`Reset ${field.label} to default`}
                disabled={saveStory.isPending}
                onClick={() => {
                  field.setValue("");
                  saveStory.mutate({ [field.key]: null } as StorySettingsPatch);
                }}
              >
                reset
              </button>
            </span>
            <input
              className={inputClass}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              placeholder={`default ${field.effective}`}
              value={field.value}
              onChange={(e) => field.setValue(e.target.value)}
            />
          </label>
        </div>
      ))}
      <div className="flex gap-2">
        <button className={buttonClass} disabled={saveStory.isPending}>
          Save
        </button>
        <button
          type="button"
          className={ghostClass}
          disabled={saveStory.isPending}
          onClick={resetAll}
        >
          Reset all to defaults
        </button>
      </div>
    </form>
  );
}

export function ProviderSelect({
  story,
  providers,
}: {
  story: Story;
  providers: Provider[] | null;
}) {
  const saveStory = useSaveStory(story.id);
  const defaultProvider = providers?.find((p) => p.isDefault) ?? null;

  return (
    <label className="flex flex-col gap-1 text-sm">
      Story provider
      <select
        className={inputClass}
        aria-label="Story provider"
        value={story.providerId ?? "default"}
        disabled={saveStory.isPending || providers === null}
        onChange={(e) => {
          const value = e.target.value;
          saveStory.mutate({ providerId: value === "default" ? null : value });
        }}
      >
        <option value="default">
          Default{defaultProvider ? ` (${providerDisplayName(defaultProvider)})` : ""}
        </option>
        {(providers ?? []).map((provider) => (
          <option key={provider.id} value={provider.id}>
            {providerDisplayName(provider)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NarrativeSection({ story }: { story: Story }) {
  const saveStory = useSaveStory(story.id);
  const [aiInstructions, setAiInstructions] = useState(story.aiInstructions);
  const [plotEssentials, setPlotEssentials] = useState(story.plotEssentials);
  const [memory, setMemory] = useState(story.memory);

  function save(e: FormEvent) {
    e.preventDefault();
    saveStory.mutate({ aiInstructions, plotEssentials, memory });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        AI instructions
        <textarea
          className={inputClass}
          rows={3}
          value={aiInstructions}
          onChange={(e) => setAiInstructions(e.target.value)}
        />
        <span className="text-xs text-text-muted">
          Appended to the base prompt, never replacing it. Tone, setting rules, and genre
          constraints welcome; length, player agency, and hook rules cannot be overridden.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Plot essentials
        <textarea
          className={inputClass}
          rows={3}
          value={plotEssentials}
          onChange={(e) => setPlotEssentials(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Author&apos;s Note
        <textarea
          className={inputClass}
          rows={3}
          value={memory}
          onChange={(e) => setMemory(e.target.value)}
        />
        <span className="text-xs text-text-muted">
          Short-term directives. Keep it under 4 sentences. For permanent facts, use Plot
          Essentials.
        </span>
      </label>
      <div>
        <button className={buttonClass} disabled={saveStory.isPending}>
          Save
        </button>
      </div>
      <div className="border-t border-border pt-3">
        <h3 className="mb-1 text-sm font-medium">Summary</h3>
        {story.summary ? (
          <p className="whitespace-pre-wrap font-serif text-sm">{story.summary}</p>
        ) : (
          <p className="text-sm text-text-muted">No summary yet.</p>
        )}
      </div>
    </form>
  );
}

export function StorySection({ story, actionCount }: { story: Story; actionCount: number }) {
  const remove = useDeleteStory();
  const save = useSaveStory(story.id);
  const completed = story.completedAt !== null && story.completedAt !== undefined;

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        <span className="text-text-muted">Created </span>
        {new Date(story.createdAt).toLocaleString()}
      </p>
      <p>
        <span className="text-text-muted">Actions </span>
        <span className="font-mono">{actionCount}</span>
      </p>
      <div>
        <button
          className="rounded border border-border px-3 py-1 text-sm hover:bg-surface-hover disabled:opacity-50"
          disabled={save.isPending}
          onClick={() => save.mutate({ completedAt: completed ? null : Date.now() })}
        >
          {completed ? "Mark playing" : "Mark complete"}
        </button>
      </div>
      <div>
        <button
          className="rounded border border-danger/50 px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete "${story.title}"? This cannot be undone.`)) {
              remove.mutate(story.id, { onSuccess: () => navigate("/") });
            }
          }}
        >
          Delete story
        </button>
      </div>
    </div>
  );
}
