import { post, request } from "./client";

export interface Script {
  id: string;
  storyId: string | null;
  scenarioId: string | null;
  name: string;
  source: string;
  enabled: boolean;
  position: number;
  createdAt: number;
}

export interface ScriptForm {
  name: string;
  source: string;
  enabled: boolean;
  position: number;
}

export function listStoryScripts(
  storyId: string,
): Promise<{ scripts: Script[]; readOnly: boolean }> {
  return request(`/api/stories/${storyId}/scripts`);
}

export function createStoryScript(storyId: string, form: ScriptForm): Promise<{ script: Script }> {
  return post(`/api/stories/${storyId}/scripts`, form);
}

export function listScenarioScripts(
  scenarioId: string,
): Promise<{ scripts: Script[]; readOnly: boolean }> {
  return request(`/api/scenarios/${scenarioId}/scripts`);
}

export function createScenarioScript(
  scenarioId: string,
  form: ScriptForm,
): Promise<{ script: Script }> {
  return post(`/api/scenarios/${scenarioId}/scripts`, form);
}

export function patchScript(
  scriptId: string,
  patch: Partial<ScriptForm>,
): Promise<{ script: Script }> {
  return request(`/api/scripts/${scriptId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteScript(scriptId: string): Promise<{ ok: boolean }> {
  return request(`/api/scripts/${scriptId}`, { method: "DELETE" });
}

export function validateScript(
  source: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return post("/api/scripts/validate", { source });
}

// Starter example shown as editor placeholder text. Mirrors the
// documented example in apps/api/src/scripts/example.ts (duplicated
// here because the web app cannot import server sources).
export const EXAMPLE_SCRIPT_PLACEHOLDER = `if (typeof text === "string" && text.includes("SHOUT")) {
  state.shouts = (state.shouts || 0) + 1;
  log("echo filter fired " + state.shouts + " time(s)");
  text = text.toUpperCase();
}
`;
