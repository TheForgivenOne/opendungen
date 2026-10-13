// Single-column scenario list (Phase 6b): full-width 56px rows used
// by the setup wizard (step 1) and the new-story flow (/scenarios/new).
// The first (fantasy) scenario is pre-selected; Enter/click selects and
// advances (parents own the advance).

import type { ScenarioListItem } from "./api/scenarios";

export function defaultScenarioId(scenarios: ScenarioListItem[], fantasyId: string): string | null {
  return scenarios.find((s) => s.id === fantasyId)?.id ?? scenarios[0]?.id ?? null;
}

export function ScenarioList({
  scenarios,
  selectedId,
  onSelect,
}: {
  scenarios: ScenarioListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col" role="listbox" aria-label="Scenarios">
      {scenarios.map((scenario) => {
        const selected = scenario.id === selectedId;
        return (
          <li key={scenario.id}>
            <button
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => onSelect(scenario.id)}
              // Native buttons already activate on Enter; the explicit
              // handler keeps the behavior identical where they do not.
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSelect(scenario.id);
                }
              }}
              className={`h-14 w-full border-l-2 px-3 py-1 text-left ${
                selected ? "border-accent bg-surface" : "border-transparent hover:bg-surface"
              }`}
            >
              <span className="block truncate text-[15px]">{scenario.title}</span>
              <span className="block truncate text-[13px] text-text-muted">
                {scenario.description}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
