// Setup wizard (Phase 6b): scenario → name → provider, then straight
// into the story with its opening turn already streaming. Three steps,
// one primary button each (Next, Next, Connect), three dots at the
// bottom. No top bar (this renders outside the shell). Completion is
// localStorage under "opendungen.wizard.v1" (not the server); steps are
// URL-driven (/wizard/step-N). Skipping the provider leaves a
// persistent banner in the story view until one is configured.

import { useState, type FormEvent } from "react";
import { errorMessage } from "../api/client";
import {
  createProvider,
  setDefaultProvider,
  testProvider,
  type ProviderForm,
} from "../api/providers";
import { navigate } from "../location";
import { queryClient, useCreateStory, useScenarios } from "../queries";
import { defaultScenarioId, ScenarioList } from "../scenario-list";
import { EMPTY_PROVIDER_FORM, ProviderFields } from "./providers/ProviderFields";
import { ErrorText, Skeleton, buttonClass, ghostClass, inputClass } from "../ui";

export const WIZARD_KEY = "opendungen.wizard.v1";
export const FANTASY_SCENARIO_ID = "builtin-fantasy-waystation";

export function readWizardDone(): boolean {
  try {
    return window.localStorage.getItem(WIZARD_KEY) === "1";
  } catch {
    return false;
  }
}

export function markWizardDone(): void {
  try {
    window.localStorage.setItem(WIZARD_KEY, "1");
  } catch {
    // Private browsing etc: the wizard simply runs again next time.
  }
}

// Skip the wizard entirely when it was completed, or when auth is off
// and a provider already exists.
export function shouldSkipWizard(authMode: string, providerCount: number, done: boolean): boolean {
  if (done) {
    return true;
  }
  return authMode === "none" && providerCount > 0;
}

// The wizard runs for authenticated users with zero providers who never
// completed it.
export function needsWizard(
  authenticated: boolean,
  providerCount: number | null,
  done: boolean,
): boolean {
  if (!authenticated || done || providerCount === null) {
    return false;
  }
  return providerCount === 0;
}

function Dots({ current }: { current: number }) {
  return (
    <div
      className="mt-8 flex items-center justify-center gap-2"
      aria-label={`Step ${current} of 3`}
    >
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${i === current ? "bg-accent" : "bg-border"}`}
        />
      ))}
    </div>
  );
}

function StepShell({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-4">
      <p className="mb-1 text-sm text-text-muted">Step {step} of 3</p>
      <h1 className="mb-4 text-xl font-bold">{title}</h1>
      {children}
      <Dots current={step} />
    </main>
  );
}

export function WizardScreen({ step }: { step: 1 | 2 | 3 }) {
  const create = useCreateStory();
  const scenariosQuery = useScenarios();
  const scenarios = scenariosQuery.data?.scenarios ?? [];

  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(EMPTY_PROVIDER_FORM);
  const [savedProviderId, setSavedProviderId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const effectiveScenarioId = scenarioId ?? defaultScenarioId(scenarios, FANTASY_SCENARIO_ID);
  const scenario = scenarios.find((s) => s.id === effectiveScenarioId) ?? scenarios[0] ?? null;
  const storyTitle = (name ?? scenario?.title ?? "").trim() || "Untitled story";

  function goName(nextScenarioId: string) {
    setScenarioId(nextScenarioId);
    navigate("/wizard/step-2");
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (saving || savedProviderId) {
      return;
    }
    setSaving(true);
    setProviderError(null);
    try {
      const data = await createProvider(form);
      // The wizard's provider becomes the default so the first story
      // can generate immediately (creation never auto-defaults).
      await setDefaultProvider(data.provider.id);
      setSavedProviderId(data.provider.id);
      setTestResult(null);
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
    } catch (err) {
      setProviderError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!savedProviderId || testing) {
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProvider(savedProviderId);
      if (result.ok) {
        setTestResult({ ok: true, text: result.model ?? "ok" });
      } else {
        setTestResult({ ok: false, text: result.error ?? "connection failed" });
      }
    } catch (err) {
      setTestResult({ ok: false, text: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  }

  // The scenario's opening is already the story's first action: the
  // story view shows it on arrival and the input is focused. No
  // auto-generation fires — the user types the first turn.
  function playAfterCreate() {
    if (create.isPending) {
      return;
    }
    create.mutate(
      { title: storyTitle, scenarioId: effectiveScenarioId },
      {
        onSuccess: (data) => {
          markWizardDone();
          navigate(`/stories/${data.story.id}`);
        },
      },
    );
  }

  if (step === 1) {
    return (
      <StepShell step={1} title="Pick a scenario">
        {scenariosQuery.isPending ? (
          <Skeleton lines={3} />
        ) : scenariosQuery.isError ? (
          <ErrorText error={errorMessage(scenariosQuery.error)} />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (effectiveScenarioId) {
                goName(effectiveScenarioId);
              }
            }}
          >
            <ScenarioList
              scenarios={scenarios}
              selectedId={effectiveScenarioId}
              onSelect={(id) => goName(id)}
            />
            <div className="mt-4">
              <button className={buttonClass} disabled={!effectiveScenarioId}>
                Next
              </button>
            </div>
          </form>
        )}
      </StepShell>
    );
  }

  if (step === 2) {
    return (
      <StepShell step={2} title="Name your character">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate("/wizard/step-3");
          }}
        >
          <input
            className={`${inputClass} border-0 border-b bg-transparent text-center font-serif !text-[18px] focus:border-accent`}
            placeholder="Name your character."
            aria-label="Name your character."
            autoFocus
            value={name ?? scenario?.title ?? ""}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="mt-4 flex items-center justify-center gap-2">
            <button className={ghostClass} type="button" onClick={() => navigate("/wizard/step-1")}>
              ← Back
            </button>
            <button className={buttonClass}>Next</button>
          </div>
        </form>
      </StepShell>
    );
  }

  return (
    <StepShell step={3} title="Connect a provider">
      <p className="mb-4 text-sm text-text-muted">
        Save a provider to power the story. You can test the connection after connecting — or skip
        for now and add one later.
      </p>
      <form onSubmit={(e) => void connect(e)} className="mb-3 flex flex-col gap-3">
        <ProviderFields
          form={form}
          onChange={(next) => setForm(next)}
          apiKeyHint=" (empty for keyless local servers)"
        />
        <ErrorText error={providerError} />
        {!savedProviderId ? (
          <div>
            <button className={buttonClass} disabled={saving}>
              {saving ? "Connecting…" : "Connect"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={ghostClass}
                disabled={testing}
                onClick={() => void runTest()}
              >
                Test connection
              </button>
              {testResult && (
                <span className={`text-sm ${testResult.ok ? "text-[#58a05c]" : "text-danger"}`}>
                  {testResult.ok ? `✓ ${testResult.text}` : `✗ ${testResult.text}`}
                </span>
              )}
            </div>
            <div>
              <button
                type="button"
                className={buttonClass}
                disabled={create.isPending}
                onClick={() => playAfterCreate()}
              >
                Start playing
              </button>
            </div>
          </div>
        )}
      </form>
      {!savedProviderId && (
        <button
          className="font-mono text-xs text-text-muted hover:text-text"
          disabled={create.isPending}
          onClick={() => playAfterCreate()}
        >
          Skip for now
        </button>
      )}
      <div className="mt-3">
        <button className={ghostClass} onClick={() => navigate("/wizard/step-2")}>
          ← Back
        </button>
      </div>
    </StepShell>
  );
}
