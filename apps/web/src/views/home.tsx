// Landing route (Phase 6c): a Home card for the most recently
// updated story (Continue / Start writing + preview), never an
// auto-navigate. With zero stories the one-scenario empty state
// (Phase 6b §5) is unchanged.

import { navigate } from "../location";
import { useCreateStory, useScenario, useScenarios, useStories, useStoryActions } from "../queries";
import { defaultScenarioId } from "../scenario-list";
import { FANTASY_SCENARIO_ID } from "./wizard";
import { Skeleton, buttonClass, formatRelative } from "../ui";

export function HomeScreen() {
  const storiesQuery = useStories();
  const stories = storiesQuery.data?.stories;

  if (storiesQuery.isError) {
    return (
      <main className="mx-auto w-full max-w-xl p-4">
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-danger">Could not load stories.</p>
          <button
            className="font-mono text-xs text-text-muted hover:text-text"
            onClick={() => navigate("/stories")}
          >
            Go to story list →
          </button>
        </div>
      </main>
    );
  }

  if (!stories) {
    return (
      <main className="mx-auto w-full max-w-xl p-4">
        <Skeleton lines={4} />
      </main>
    );
  }

  if (stories.length === 0) {
    return <EmptyState />;
  }

  const newest = [...stories].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!newest) {
    return <EmptyState />;
  }
  return <ContinueCard storyId={newest.id} />;
}

function EmptyState() {
  const scenariosQuery = useScenarios();
  const create = useCreateStory();

  // Zero stories: one scenario card. The first built-in (fantasy).
  const scenarios = scenariosQuery.data?.scenarios ?? [];
  const featured =
    scenarios.find((s) => s.id === defaultScenarioId(scenarios, FANTASY_SCENARIO_ID)) ?? null;

  function begin() {
    if (!featured || create.isPending) {
      return;
    }
    create.mutate(
      { title: featured.title, scenarioId: featured.id },
      { onSuccess: (data) => navigate(`/stories/${data.story.id}`) },
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center p-4">
      <div className="mt-16 w-full max-w-[480px] py-10 text-center">
        {scenariosQuery.isPending ? (
          <Skeleton lines={3} />
        ) : scenariosQuery.isError || !featured ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-danger">Could not load scenarios.</p>
            <button
              className="font-mono text-xs text-text-muted hover:text-text"
              onClick={() => navigate("/scenarios")}
            >
              Browse all scenarios →
            </button>
          </div>
        ) : (
          <>
            <h1 className="font-serif text-[20px]">{featured.title}</h1>
            <p className="mx-auto mt-2 max-w-[400px] text-sm text-text-muted">
              {featured.description}
            </p>
            <button
              className={`${buttonClass} mt-6 w-full`}
              disabled={create.isPending}
              onClick={begin}
            >
              Begin
            </button>
            <button
              className="mt-4 font-mono text-xs text-text-muted hover:text-text"
              onClick={() => navigate("/scenarios")}
            >
              Browse all scenarios
            </button>
          </>
        )}
      </div>
    </main>
  );
}

function ContinueCard({ storyId }: { storyId: string }) {
  const storiesQuery = useStories();
  const scenariosQuery = useScenarios();
  const actionsQuery = useStoryActions(storyId);

  const stories = storiesQuery.data?.stories ?? [];
  const scenarios = scenariosQuery.data?.scenarios ?? [];
  const story = stories.find((s) => s.id === storyId) ?? null;
  const scenario = scenarios.find((s) => s.id === story?.scenarioId) ?? null;
  // The scenario opening (fallback preview) lives on the detail, not
  // the list item — fetched only when the story points at one.
  const scenarioQuery = useScenario(story?.scenarioId ?? "", !!story?.scenarioId);

  if (!story) {
    return (
      <main className="mx-auto w-full max-w-xl p-4">
        <Skeleton lines={4} />
      </main>
    );
  }

  const actions = actionsQuery.data?.actions ?? [];
  const isDraft = actionsQuery.isSuccess && actions.length === 0;
  // Preview: the last action's text (an errored turn ends in an input
  // with no output yet); with no actions, the scenario opening.
  const preview = actions.length
    ? (actions[actions.length - 1]?.text ?? "")
    : (scenarioQuery.data?.scenario.opening ?? "");

  const contextLine = scenario
    ? `${scenario.title}${scenario.tags[0] ? ` · ${scenario.tags[0]}` : ""}`
    : null;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center p-4">
      <div className="mt-16 w-full max-w-[480px] py-10 text-center" data-testid="continue-card">
        <p className="text-sm uppercase text-text-muted">Continue</p>
        <h1 className="mt-4 font-serif text-[22px]" data-testid="continue-title">
          {story.title}
        </h1>
        {contextLine && (
          <p className="mt-1 text-[13px] text-text-muted" data-testid="continue-context">
            {contextLine}
          </p>
        )}
        <p className="mt-1 font-mono text-xs text-text-muted" data-testid="continue-meta">
          Last played {formatRelative(story.updatedAt)}
          {actionsQuery.isSuccess
            ? ` · ${actions.length} action${actions.length === 1 ? "" : "s"}`
            : ""}
        </p>
        {actionsQuery.isPending || (story.scenarioId && scenarioQuery.isPending) ? (
          <div className="mt-4">
            <Skeleton lines={2} />
          </div>
        ) : (
          preview && (
            <p
              className="mx-auto mt-4 line-clamp-2 max-w-[400px] font-serif text-[14px] text-text-muted"
              data-testid="continue-preview"
            >
              “{preview}”
            </p>
          )
        )}
        <button
          className={`${buttonClass} mt-6 w-full`}
          data-testid="continue-button"
          onClick={() => navigate(`/stories/${story.id}`)}
        >
          {isDraft ? "Start writing" : "Continue"}
        </button>
        <button
          className="mt-4 font-mono text-xs text-text-muted hover:text-text"
          onClick={() => navigate("/stories")}
        >
          All stories →
        </button>
      </div>
    </main>
  );
}
