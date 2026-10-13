// Shared model-listing helpers: every adapter returns deduplicated,
// sorted id strings capped at 500.

export const MAX_LISTED_MODELS = 500;

export function normalizeModelList(ids: unknown[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) {
      seen.add(id);
    }
  }
  return [...seen].sort().slice(0, MAX_LISTED_MODELS);
}

// testConnection model choice: the configured model when the listing
// contains it, else the first listed model, else the configured string.
export function pickTestModel(configured: string, models: string[]): string {
  if (models.includes(configured)) {
    return configured;
  }
  if (models.length > 0) {
    return models[0] as string;
  }
  return configured;
}
