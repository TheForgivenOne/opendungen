import { post, request } from "./client";

export interface Story {
  id: string;
  userId: string;
  scenarioId: string | null;
  title: string;
  aiInstructions: string;
  plotEssentials: string;
  memory: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  // Persistent provider override (null = default) + nullable
  // context/compressor overrides (null = shared constants).
  providerId: string | null;
  compressTriggerPct: number | null;
  compressMaxTokens: number | null;
  compressTemperature: number | null;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  // Completion marker; null = playing.
  completedAt: number | null;
}

export interface StorySettingsPatch {
  title?: string;
  aiInstructions?: string;
  plotEssentials?: string;
  memory?: string;
  providerId?: string | null;
  compressTriggerPct?: number | null;
  compressMaxTokens?: number | null;
  compressTemperature?: number | null;
  contextTokens?: number | null;
  maxOutputTokens?: number | null;
  completedAt?: number | null;
}

export type ActionMode = "do" | "say" | "story";

export interface StoryAction {
  id: string;
  storyId: string;
  idx: number;
  type: "input" | "output" | "continue";
  text: string;
  // Player input mode; null = AI output (or pre-Phase-6 rows).
  mode: ActionMode | null;
  createdAt: number;
}

export function listStories(): Promise<{ stories: Story[] }> {
  return request("/api/stories");
}

export function createStory(title: string, scenarioId?: string | null): Promise<{ story: Story }> {
  return post("/api/stories", scenarioId ? { title, scenarioId } : { title });
}

export function getStory(id: string): Promise<{ story: Story }> {
  return request(`/api/stories/${id}`);
}

export function patchStory(id: string, patch: StorySettingsPatch): Promise<{ story: Story }> {
  return request(`/api/stories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteStory(id: string): Promise<{ story: Story }> {
  return request(`/api/stories/${id}`, { method: "DELETE" });
}

export function listActions(id: string): Promise<{ actions: StoryAction[] }> {
  return request(`/api/stories/${id}/actions`);
}

export function appendAction(
  id: string,
  text: string,
  mode?: ActionMode,
): Promise<{ action: StoryAction }> {
  return post(
    `/api/stories/${id}/actions`,
    mode ? { type: "input", text, mode } : { type: "input", text },
  );
}
