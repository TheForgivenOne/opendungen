// Scenario detail screen.

import { errorMessage } from "../../api/client";
import { type ScenarioDetail } from "../../api/scenarios";
import { navigate } from "../../location";
import { useCreateStory, useDuplicateScenario, usePatchScenario, useScenario } from "../../queries";
import { ErrorText, ScenarioTag, Skeleton, buttonClass, ghostClass } from "../../ui";
import { ScenarioEditor } from "./ScenarioEditor";

export function ScenarioScreen({ id }: { id: string }) {
  const scenarioQuery = useScenario(id);
  const patchScenario = usePatchScenario(id);
  const duplicateScenario = useDuplicateScenario();
  const scenario: ScenarioDetail | null = scenarioQuery.data?.scenario ?? null;

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <button className={`${ghostClass} mb-4`} onClick={() => navigate("/scenarios")}>
        ← Scenarios
      </button>
      {scenarioQuery.isPending ? (
        <Skeleton lines={4} />
      ) : scenarioQuery.isError || !scenario ? (
        <ErrorText
          error={scenarioQuery.isError ? errorMessage(scenarioQuery.error) : "not found"}
        />
      ) : scenario.builtin ? (
        <article className="rounded border border-border bg-surface p-4">
          <h1 className="mb-1 text-xl font-bold">{scenario.title}</h1>
          <p className="mb-3 text-sm text-text-muted">{scenario.description}</p>
          {scenario.tags.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {scenario.tags.map((tag) => (
                <ScenarioTag key={tag} tag={tag} />
              ))}
            </div>
          )}
          <h2 className="mb-1 font-bold">Opening</h2>
          <p className="mb-3 whitespace-pre-wrap text-sm">{scenario.opening}</p>
          <h2 className="mb-1 font-bold">AI instructions</h2>
          <p className="mb-4 whitespace-pre-wrap text-sm text-text-muted">
            {scenario.aiInstructions}
          </p>
          <div className="flex flex-wrap gap-2">
            <StartFromScenarioButton scenarioId={id} title={scenario.title} />
            <button
              className={ghostClass}
              disabled={duplicateScenario.isPending}
              onClick={() =>
                duplicateScenario.mutate(id, {
                  onSuccess: (data) => navigate(`/scenarios/${data.scenario.id}`),
                })
              }
            >
              Duplicate to edit
            </button>
          </div>
        </article>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded border border-border bg-surface p-4">
            <ScenarioEditor
              key={scenario.id}
              initial={{
                title: scenario.title,
                description: scenario.description,
                opening: scenario.opening,
                aiInstructions: scenario.aiInstructions,
                tags: scenario.tags,
              }}
              heading={scenario.title}
              onDone={async (form) => {
                await patchScenario.mutateAsync(form);
              }}
            />
          </div>
          <StartFromScenarioButton scenarioId={id} title={scenario.title} />
        </div>
      )}
    </div>
  );
}

function StartFromScenarioButton({ scenarioId, title }: { scenarioId: string; title: string }) {
  const create = useCreateStory();
  return (
    <button
      className={buttonClass}
      disabled={create.isPending}
      onClick={() =>
        create.mutate(
          { title, scenarioId },
          { onSuccess: (data) => navigate(`/stories/${data.story.id}`) },
        )
      }
    >
      Start a story here
    </button>
  );
}

// Two-screen new-story flow: a single-column scenario list,
// then one centered name field. Top-level routes, no grid, no modal.
// The list selection travels in sessionStorage (the name screen reads
