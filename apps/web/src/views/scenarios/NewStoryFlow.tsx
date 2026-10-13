// Two-screen new-story flow (Phase 6b): scenario list, then the name field.

import { useState, type FormEvent } from "react";
import { errorMessage } from "../../api/client";
import { navigate } from "../../location";
import { useCreateStory, useScenarios } from "../../queries";
import { defaultScenarioId, ScenarioList } from "../../scenario-list";
import { FANTASY_SCENARIO_ID } from "../wizard";
import { ErrorText, Skeleton, inputClass } from "../../ui";

// Two-screen new-story flow (Phase 6b): a single-column scenario list,
// then one centered name field. Top-level routes, no grid, no modal.
// The list selection travels in sessionStorage (the name screen reads
// it; a direct visit falls back to the fantasy default).
const NEW_STORY_SCENARIO_KEY = "opendungen.newStory.scenarioId";

export function saveNewStoryScenario(id: string): void {
  try {
    window.sessionStorage.setItem(NEW_STORY_SCENARIO_KEY, id);
  } catch {
    // Storage unavailable: the name screen falls back to the default.
  }
}

export function readNewStoryScenario(): string | null {
  try {
    return window.sessionStorage.getItem(NEW_STORY_SCENARIO_KEY) ?? null;
  } catch {
    return null;
  }
}

export function NewScenarioScreen() {
  const scenariosQuery = useScenarios();
  const scenarios = scenariosQuery.data?.scenarios ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effective = selectedId ?? defaultScenarioId(scenarios, FANTASY_SCENARIO_ID);

  function advance(id: string | null) {
    const next = id ?? defaultScenarioId(scenarios, FANTASY_SCENARIO_ID);
    if (!next) {
      return;
    }
    saveNewStoryScenario(next);
    navigate("/scenarios/new/name");
  }

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <h1 className="mb-4 text-xl font-bold">New story</h1>
      {scenariosQuery.isPending ? (
        <Skeleton lines={3} />
      ) : scenariosQuery.isError ? (
        <ErrorText error={errorMessage(scenariosQuery.error)} />
      ) : (
        <ScenarioList
          scenarios={scenarios}
          selectedId={effective}
          onSelect={(id) => {
            setSelectedId(id);
            advance(id);
          }}
        />
      )}
    </div>
  );
}

export function NewScenarioNameScreen() {
  const scenariosQuery = useScenarios();
  const create = useCreateStory();
  const scenarios = scenariosQuery.data?.scenarios ?? [];
  const stored = readNewStoryScenario();
  const scenario =
    scenarios.find((s) => s.id === stored) ??
    scenarios.find((s) => s.id === defaultScenarioId(scenarios, FANTASY_SCENARIO_ID)) ??
    scenarios[0] ??
    null;
  const [name, setName] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!scenario || create.isPending) {
      return;
    }
    const title = (name ?? scenario.title).trim() || scenario.title;
    create.mutate(
      { title, scenarioId: scenario.id },
      { onSuccess: (data) => navigate(`/stories/${data.story.id}`) },
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center p-4">
      <form onSubmit={submit} className="mt-16 w-full max-w-[480px]">
        {scenariosQuery.isPending ? (
          <Skeleton lines={2} />
        ) : scenariosQuery.isError || !scenario ? (
          <ErrorText
            error={scenariosQuery.isError ? errorMessage(scenariosQuery.error) : "not found"}
          />
        ) : (
          <input
            className={`${inputClass} border-0 border-b bg-transparent text-center font-serif !text-[18px] focus:border-accent`}
            placeholder="Name your character."
            aria-label="Name your character."
            autoFocus
            value={name ?? scenario.title}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        )}
      </form>
    </div>
  );
}
