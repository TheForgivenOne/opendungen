// Scenario create/edit form (used by the list and detail screens).

import { useState, type FormEvent } from "react";
import { errorMessage } from "../../api/client";
import { scenarioTagsToText, scenarioTextToTags, type ScenarioForm } from "../../api/scenarios";
import { ErrorText, buttonClass, inputClass } from "../../ui";

export const EMPTY_FORM: ScenarioForm = {
  title: "",
  description: "",
  opening: "",
  aiInstructions: "",
  tags: [],
};

export function ScenarioEditor({
  initial,
  heading,
  onDone,
}: {
  initial: ScenarioForm;
  heading: string;
  onDone: (form: ScenarioForm) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [opening, setOpening] = useState(initial.opening);
  const [aiInstructions, setAiInstructions] = useState(initial.aiInstructions);
  const [tags, setTags] = useState(scenarioTagsToText(initial.tags));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onDone({
        title: title.trim(),
        description,
        opening,
        aiInstructions,
        tags: scenarioTextToTags(tags),
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <h2 className="font-bold">{heading}</h2>
      <ErrorText error={error} />
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Description
        <textarea
          className={inputClass}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Opening
        <textarea
          className={inputClass}
          rows={4}
          value={opening}
          onChange={(e) => setOpening(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        AI instructions
        <textarea
          className={inputClass}
          rows={4}
          value={aiInstructions}
          onChange={(e) => setAiInstructions(e.target.value)}
        />
        <span className="text-xs text-text-muted">
          Appended to the base prompt, never replacing it. Add tone, setting rules, genre
          constraints, content boundaries, or character voice guidance. Length target, player agency
          rules, anti-summarization, and the end-on-a-hook constraint cannot be overridden.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Tags (comma-separated)
        <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <div>
        <button className={buttonClass} disabled={busy || !title.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}
