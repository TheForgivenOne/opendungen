import { ApiError } from "./client";

export interface ImportSummary {
  imported: Record<string, number>;
  skipped: { entity: string; id?: string; reason: string }[];
}

export async function downloadExportAll(): Promise<void> {
  const res = await fetch("/api/export/all");
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "request_failed", err?.message ?? "export failed");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `opendungen-export-${Date.now()}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function importBackup(
  file: File,
  mode: "merge" | "replace",
  confirmDelete: boolean,
): Promise<ImportSummary> {
  const form = new FormData();
  form.append("file", file);
  const query =
    mode === "replace" && confirmDelete ? "?mode=replace&confirm=DELETE" : `?mode=${mode}`;
  const res = await fetch(`/api/import${query}`, { method: "POST", body: form });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "request_failed",
      err?.message ?? `request failed: ${res.status}`,
    );
  }
  return data as ImportSummary;
}

export interface ImportPreview {
  stories: number;
  actions: number;
  cards: number;
  scripts: number;
  warnings: string[];
}

// Client-side preview of an export file: counts plus warnings. The
// server re-validates everything on import.
export async function previewBackup(file: File): Promise<ImportPreview> {
  const text = await file.text();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("file is not valid JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("file must contain a JSON object");
  }
  const record = doc as Record<string, unknown>;
  if (record.opendungen !== 1) {
    throw new Error("unsupported export version: expected 1");
  }
  const stories = Array.isArray(record.stories) ? record.stories : [];
  let actions = 0;
  let cards = 0;
  let scripts = 0;
  for (const bundle of stories) {
    if (bundle && typeof bundle === "object" && !Array.isArray(bundle)) {
      const b = bundle as Record<string, unknown>;
      if (Array.isArray(b.actions)) {
        actions += b.actions.length;
      }
      if (Array.isArray(b.cards)) {
        cards += b.cards.length;
      }
      if (Array.isArray(b.scripts)) {
        scripts += b.scripts.length;
      }
    }
  }
  const warnings: string[] = [];
  if (text.includes("api_key_enc")) {
    warnings.push("file contains provider keys; they will be ignored (re-enter keys after import)");
  }
  return { stories: stories.length, actions, cards, scripts, warnings };
}
