// Story/script management panel (story view drawer + scenario detail).

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../api/client";
import {
  EXAMPLE_SCRIPT_PLACEHOLDER,
  createScenarioScript,
  createStoryScript,
  deleteScript,
  patchScript,
  validateScript,
  type Script,
} from "../../api/scripts";
import { useScenarioScripts, useStoryScripts } from "../../queries";
import { useToast } from "../../toast";
import { ErrorText, buttonClass, ghostClass, inputClass } from "../../ui";

export function ScriptsPanel({
  owner,
}: {
  owner: { kind: "story"; id: string } | { kind: "scenario"; id: string };
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const storyQuery = useStoryScripts(
    owner.kind === "story" ? owner.id : "",
    owner.kind === "story" && expanded,
  );
  const scenarioQuery = useScenarioScripts(
    owner.kind === "scenario" ? owner.id : "",
    owner.kind === "scenario" && expanded,
  );
  const data = owner.kind === "story" ? storyQuery.data : scenarioQuery.data;
  const scripts = data?.scripts ?? null;
  const readOnly = data?.readOnly ?? false;
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const title = owner.kind === "story" ? "Story scripts" : "Scenario scripts";

  async function refresh() {
    await client.invalidateQueries({
      queryKey: owner.kind === "story" ? ["scripts", owner.id] : ["scenario-scripts", owner.id],
    });
  }

  function resetForm() {
    setName("");
    setSource("");
    setEnabled(true);
    setEditingId(null);
    setValidateResult(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !source.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await patchScript(editingId, { name: name.trim(), source, enabled });
      } else if (owner.kind === "story") {
        await createStoryScript(owner.id, {
          name: name.trim(),
          source,
          enabled,
          position: scripts?.length ?? 0,
        });
      } else {
        await createScenarioScript(owner.id, {
          name: name.trim(),
          source,
          enabled,
          position: scripts?.length ?? 0,
        });
      }
      resetForm();
      await refresh();
    } catch (err) {
      toast.push("error", errorMessage(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!source.trim()) {
      return;
    }
    setValidateResult("validating…");
    try {
      const result = await validateScript(source);
      setValidateResult(result.ok ? "Valid script." : `Invalid: ${result.error}`);
    } catch (err) {
      setValidateResult(`Validation failed: ${errorMessage(err)}`);
    }
  }

  async function toggle(script: Script) {
    try {
      await patchScript(script.id, { enabled: !script.enabled });
      await refresh();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  async function remove(scriptId: string) {
    try {
      await deleteScript(scriptId);
      if (editingId === scriptId) {
        resetForm();
      }
      await refresh();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  return (
    <div>
      <button
        className="flex w-full items-center justify-between py-2 text-left text-sm font-medium"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        {title}
        <span className="text-text-muted">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="pb-2">
          <ErrorText error={error} />
          {scripts === null ? (
            <p className="text-text-muted">loading…</p>
          ) : scripts.length === 0 ? (
            <p className="mb-3 text-sm text-text-muted">No scripts yet.</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-2">
              {scripts.map((script) => (
                <li key={script.id} className="border-b border-border py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {script.name}{" "}
                      {!script.enabled && <span className="text-text-muted">(disabled)</span>}
                    </span>
                    {!readOnly && (
                      <div className="flex gap-3 font-mono text-xs">
                        <button
                          className="text-text-muted hover:text-text"
                          onClick={() => void toggle(script)}
                        >
                          {script.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          className="text-text-muted hover:text-text"
                          onClick={() => {
                            setEditingId(script.id);
                            setName(script.name);
                            setSource(script.source);
                            setEnabled(script.enabled);
                            setValidateResult(null);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="text-text-muted hover:text-danger"
                          onClick={() => void remove(script.id)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                  {readOnly && (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text-muted">
                      {script.source}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{editingId ? "Edit script" : "Add script"}</h3>
              <input
                className={inputClass}
                placeholder="Script name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <textarea
                className={`${inputClass} font-mono text-xs`}
                rows={8}
                placeholder={EXAMPLE_SCRIPT_PLACEHOLDER}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Enabled
              </label>
              {validateResult && <p className="text-sm">{validateResult}</p>}
              <div className="flex gap-2">
                <button className={buttonClass} disabled={busy}>
                  {editingId ? "Save" : "Add"}
                </button>
                <button type="button" className={ghostClass} onClick={() => void validate()}>
                  Validate
                </button>
                {editingId && (
                  <button type="button" className={ghostClass} onClick={resetForm}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
