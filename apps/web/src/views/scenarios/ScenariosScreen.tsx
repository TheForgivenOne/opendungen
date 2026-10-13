// Scenarios list screen.

import { useState } from "react";
import { errorMessage } from "../../api/client";
import { navigate } from "../../location";
import { PageHeader } from "../../shell";
import {
  useCreateScenario,
  useDeleteScenario,
  useDuplicateScenario,
  useScenarios,
} from "../../queries";
import { ErrorText, Modal, ScenarioTag, Skeleton, buttonClass, ghostClass } from "../../ui";
import { EMPTY_FORM, ScenarioEditor } from "./ScenarioEditor";

export function ScenariosScreen() {
  const scenariosQuery = useScenarios();
  const createScenario = useCreateScenario();
  const duplicateScenario = useDuplicateScenario();
  const deleteScenario = useDeleteScenario();
  const [creating, setCreating] = useState(false);

  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete scenario "${title}"? Stories keep their content.`)) {
      return;
    }
    deleteScenario.mutate(id);
  }

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <PageHeader
        title="Scenarios"
        action={
          <button className={buttonClass} onClick={() => setCreating(true)}>
            New scenario
          </button>
        }
      />
      {scenariosQuery.isPending ? (
        <Skeleton lines={3} />
      ) : scenariosQuery.isError ? (
        <ErrorText error={errorMessage(scenariosQuery.error)} />
      ) : (
        <ul className="flex flex-col gap-2">
          {scenariosQuery.data.scenarios.map((scenario) => (
            <li key={scenario.id} className="rounded border border-border bg-surface p-3">
              <button
                className="w-full text-left"
                onClick={() => navigate(`/scenarios/${scenario.id}`)}
              >
                <span className="font-medium">{scenario.title}</span>
                {!scenario.builtin && <span className="ml-2 text-xs text-text-muted">(yours)</span>}
                <span className="block text-sm text-text-muted">{scenario.description}</span>
                {scenario.tags.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {scenario.tags.map((tag) => (
                      <ScenarioTag key={tag} tag={tag} />
                    ))}
                  </span>
                )}
              </button>
              <div className="mt-2 flex gap-2">
                {scenario.builtin ? (
                  <button
                    className={ghostClass}
                    disabled={duplicateScenario.isPending}
                    onClick={() =>
                      duplicateScenario.mutate(scenario.id, {
                        onSuccess: (data) => navigate(`/scenarios/${data.scenario.id}`),
                      })
                    }
                  >
                    Duplicate
                  </button>
                ) : (
                  <>
                    <button
                      className={ghostClass}
                      onClick={() => navigate(`/scenarios/${scenario.id}`)}
                    >
                      Edit
                    </button>
                    <button
                      className={ghostClass}
                      disabled={deleteScenario.isPending}
                      onClick={() => void remove(scenario.id, scenario.title)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <Modal title="New scenario" onClose={() => setCreating(false)}>
          <ScenarioEditor
            initial={EMPTY_FORM}
            heading="New scenario"
            onDone={async (form) => {
              const data = await createScenario.mutateAsync(form);
              setCreating(false);
              navigate(`/scenarios/${data.scenario.id}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
