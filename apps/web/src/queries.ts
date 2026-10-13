// Server state via react-query. Query keys are the documented set;
// mutations invalidate the relevant key. SSE streams stay in local
// component state (see the story view). A global 401 handler clears the
// auth-state cache and sends the user to /login.

import {
  MutationCache,
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  createScenario,
  deleteScenario,
  duplicateScenario,
  getScenario,
  listScenarios,
  patchScenario,
  type ScenarioDetail,
  type ScenarioForm,
  type ScenarioListItem,
} from "./api/scenarios";
import { deleteRange, listRanges } from "./api/ranges";
import { getAccountSettings, getInstanceSettings } from "./api/settings";
import { getMe, getState } from "./api/auth";
import { listProviders, type Provider } from "./api/providers";
import { listScenarioScripts, listStoryScripts } from "./api/scripts";
import { ApiError, errorMessage } from "./api/client";
import {
  createStory,
  deleteStory,
  getStory,
  listActions,
  listStories,
  patchStory,
  type Story,
  type StoryAction,
  type StorySettingsPatch,
} from "./api/stories";
import { navigate } from "./location";
import { clearLoginRedirect, readLoginRedirect, saveLoginRedirect } from "./boot";
import { useToast } from "./toast";

function handleAuthError(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) {
    // Remember where the user was headed so login returns them
    // there instead of /. Auth and wizard paths are never targets.
    const path = window.location.pathname;
    if (path !== "/login" && path !== "/setup" && !path.startsWith("/wizard/")) {
      saveLoginRedirect(path);
    } else {
      clearLoginRedirect();
    }
    queryClient.setQueryData(["auth-state"], (old: unknown) =>
      old && typeof old === "object" ? { ...old, authenticated: false } : old,
    );
    navigate("/login");
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: { queries: { retry: false, staleTime: 5000 } },
});

export function useAuthState() {
  return useQuery({ queryKey: ["auth-state"], queryFn: getState });
}

export function useMe(enabled = true) {
  return useQuery({ queryKey: ["me"], queryFn: getMe, enabled });
}

export function useStories(enabled = true) {
  return useQuery({ queryKey: ["stories"], queryFn: listStories, enabled });
}

export function useStory(id: string, enabled = true) {
  return useQuery({ queryKey: ["story", id], queryFn: () => getStory(id), enabled });
}

export function useStoryActions(storyId: string, enabled = true) {
  return useQuery({ queryKey: ["actions", storyId], queryFn: () => listActions(storyId), enabled });
}

export function useProviders(enabled = true) {
  return useQuery({ queryKey: ["providers"], queryFn: listProviders, enabled });
}

export function useScenarios(enabled = true) {
  return useQuery({ queryKey: ["scenarios"], queryFn: listScenarios, enabled });
}

export function useScenario(id: string, enabled = true) {
  return useQuery({ queryKey: ["scenario", id], queryFn: () => getScenario(id), enabled });
}

export function useRanges(storyId: string, enabled = true) {
  return useQuery({ queryKey: ["ranges", storyId], queryFn: () => listRanges(storyId), enabled });
}

export function useStoryScripts(storyId: string, enabled = true) {
  return useQuery({
    queryKey: ["scripts", storyId],
    queryFn: () => listStoryScripts(storyId),
    enabled,
  });
}

export function useScenarioScripts(scenarioId: string, enabled = true) {
  return useQuery({
    queryKey: ["scenario-scripts", scenarioId],
    queryFn: () => listScenarioScripts(scenarioId),
    enabled,
  });
}

export function useInstanceSettings(enabled = true) {
  return useQuery({ queryKey: ["instance-settings"], queryFn: getInstanceSettings, enabled });
}

export function useAccountSettings(enabled = true) {
  return useQuery({ queryKey: ["account-settings"], queryFn: getAccountSettings, enabled });
}

// Mutations toast network failures and leave form state intact (callers
// keep their local state; nothing is cleared here).

export function useCreateStory(): UseMutationResult<
  { story: Story },
  Error,
  { title: string; scenarioId?: string | null }
> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { title: string; scenarioId?: string | null }) =>
      createStory(input.title, input.scenarioId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["stories"] });
      toast.push("success", "Story created.");
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export function useDeleteStory(): UseMutationResult<{ story: Story }, Error, string> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => deleteStory(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["stories"] });
      toast.push("success", "Story deleted.");
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export function useSaveStory(
  id: string,
): UseMutationResult<{ story: Story }, Error, StorySettingsPatch> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: StorySettingsPatch) => patchStory(id, patch),
    onSuccess: (data) => {
      client.setQueryData(["story", id], { story: data.story });
      void client.invalidateQueries({ queryKey: ["stories"] });
      toast.push("success", "Story saved.");
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export function useCreateScenario(): UseMutationResult<
  { scenario: ScenarioDetail },
  Error,
  ScenarioForm
> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (form: ScenarioForm) => createScenario(form),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["scenarios"] });
      toast.push("success", "Scenario created.");
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export function usePatchScenario(
  id: string,
): UseMutationResult<{ scenario: ScenarioDetail }, Error, Partial<ScenarioForm>> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: Partial<ScenarioForm>) => patchScenario(id, patch),
    onSuccess: (data) => {
      client.setQueryData(["scenario", id], { scenario: data.scenario });
      void client.invalidateQueries({ queryKey: ["scenarios"] });
      toast.push("success", "Scenario saved.");
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export function useDeleteScenario(): UseMutationResult<{ ok: boolean }, Error, string> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => deleteScenario(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["scenarios"] });
      toast.push("success", "Scenario deleted.");
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export function useDuplicateScenario(): UseMutationResult<
  { scenario: ScenarioDetail },
  Error,
  string
> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => duplicateScenario(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["scenarios"] });
      toast.push("success", "Scenario duplicated.");
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export function useDeleteRange(storyId: string): UseMutationResult<{ ok: boolean }, Error, string> {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (rangeId: string) => deleteRange(rangeId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["ranges", storyId] });
    },
    onError: (err) => toast.push("error", errorMessage(err)),
  });
}

export { clearLoginRedirect, readLoginRedirect, saveLoginRedirect };
export type { Provider, ScenarioDetail, ScenarioListItem, Story, StoryAction };
