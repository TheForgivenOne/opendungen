import { post, request } from "./client";

export interface ScenarioListItem {
  id: string;
  title: string;
  description: string;
  tags: string[];
  builtin: boolean;
}

export interface ScenarioDetail extends ScenarioListItem {
  opening: string;
  aiInstructions: string;
}

export function listScenarios(): Promise<{ scenarios: ScenarioListItem[] }> {
  return request("/api/scenarios");
}

export function getScenario(id: string): Promise<{ scenario: ScenarioDetail }> {
  return request(`/api/scenarios/${id}`);
}

export interface ScenarioForm {
  title: string;
  description: string;
  opening: string;
  aiInstructions: string;
  tags: string[];
}

export function createScenario(form: ScenarioForm): Promise<{ scenario: ScenarioDetail }> {
  return post("/api/scenarios", form);
}

export function patchScenario(
  id: string,
  patch: Partial<ScenarioForm>,
): Promise<{ scenario: ScenarioDetail }> {
  return request(`/api/scenarios/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteScenario(id: string): Promise<{ ok: boolean }> {
  return request(`/api/scenarios/${id}`, { method: "DELETE" });
}

export function duplicateScenario(id: string): Promise<{ scenario: ScenarioDetail }> {
  return post(`/api/scenarios/${id}/duplicate`);
}

export function scenarioTagsToText(tags: string[]): string {
  return tags.join(", ");
}

export function scenarioTextToTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
