import { describe, expect, it } from "vitest";
import type { createApp } from "./app";
import { compressedRanges, scriptStates } from "./db/schema";
import { createTestApp, mockProviderFactory, setupAdmin } from "./testing";

type App = ReturnType<typeof createApp>;

async function json(app: App, method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie) {
    headers["cookie"] = cookie;
  }
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function importFile(app: App, file: Blob | string, query: string, cookie: string) {
  const form = new FormData();
  form.append(
    "file",
    typeof file === "string" ? new Blob([file], { type: "text/plain" }) : file,
    "export.json",
  );
  return app.request(`/api/import${query}`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

interface ExportDoc {
  opendungen: number;
  exportedAt: number;
  stories: {
    story: { id: string; title: string; scenarioId: string | null };
    actions: { id: string; idx: number; type: string; text: string }[];
    cards: { id: string }[];
    ranges: { id: string; parentRangeId: string | null }[];
    scripts: { id: string }[];
    states: { scriptId: string }[];
  }[];
  scenarios: { id: string; title: string }[];
  providerConfigs: Record<string, unknown>[];
}

// A story with one input/output pair, a card, a nested range pair, a
// script and its state — enough structure for round-trip comparison.
async function seedFullStory(app: App, cookie: string, title: string) {
  const created = await json(app, "POST", "/api/stories", { title }, cookie);
  expect(created.status).toBe(201);
  const { story } = (await created.json()) as { story: { id: string } };
  const provider = await json(
    app,
    "POST",
    "/api/providers",
    { label: "mock", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "mock" },
    cookie,
  );
  expect(provider.status).toBe(201);
  const { provider: prow } = (await provider.json()) as { provider: { id: string } };
  const def = await json(app, "POST", `/api/providers/${prow.id}/default`, undefined, cookie);
  expect(def.status).toBe(200);
  const gen = await json(
    app,
    "POST",
    `/api/stories/${story.id}/generate`,
    { input: "look around" },
    cookie,
  );
  expect(gen.status).toBe(200);
  await gen.text();
  const card = await json(
    app,
    "POST",
    `/api/stories/${story.id}/cards`,
    { keys: ["lantern"], entry: "A brass lantern." },
    cookie,
  );
  expect(card.status).toBe(201);
  const script = await json(
    app,
    "POST",
    `/api/stories/${story.id}/scripts`,
    { name: "echo", source: "text;" },
    cookie,
  );
  expect(script.status).toBe(201);
  const { script: scriptRow } = (await script.json()) as { script: { id: string } };
  return { storyId: story.id, scriptId: scriptRow.id };
}

describe("export/import", () => {
  it("exports one story with full data and no keys", async () => {
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await seedFullStory(app, cookie, "Export Me");
    // Ranges and states have no write API; insert representative rows.
    const now = Date.now();
    await db.insert(compressedRanges).values({
      id: "range-parent",
      storyId,
      startIdx: 0,
      endIdx: 1,
      summary: "parent",
      parentRangeId: null,
      createdAt: now,
    });
    await db.insert(compressedRanges).values({
      id: "range-child",
      storyId,
      startIdx: 0,
      endIdx: 0,
      summary: "child",
      parentRangeId: "range-parent",
      createdAt: now,
    });

    const res = await json(app, "GET", `/api/export/story/${storyId}`, undefined, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const doc = (await res.json()) as ExportDoc;
    expect(doc.opendungen).toBe(1);
    expect(typeof doc.exportedAt).toBe("number");
    expect(doc.stories).toHaveLength(1);
    const bundle = doc.stories[0];
    expect(bundle.story.title).toBe("Export Me");
    expect(bundle.actions).toHaveLength(2);
    expect(bundle.actions.map((a) => a.idx)).toEqual([0, 1]);
    expect(bundle.cards).toHaveLength(1);
    expect(bundle.ranges).toHaveLength(2);
    expect(bundle.scripts).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toContain("api_key_enc");
    expect(JSON.stringify(doc)).not.toContain("apiKeyEnc");
  });

  it("exports everything without keys, even with ?includeKeys=true", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    // seedFullStory already creates one provider.
    await seedFullStory(app, cookie, "All Mine");

    for (const query of ["", "?includeKeys=true"]) {
      const res = await json(app, "GET", `/api/export/all${query}`, undefined, cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      const doc = (await res.json()) as ExportDoc;
      expect(doc.stories).toHaveLength(1);
      expect(doc.providerConfigs).toHaveLength(1);
      expect(JSON.stringify(doc)).not.toContain("api_key_enc");
    }
  });

  it("round-trips merge: 2x data, new ids, same structure", async () => {
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await seedFullStory(app, cookie, "Round Trip");
    // A nested range pair exercises parent-id remapping on import.
    const now = Date.now();
    await db.insert(compressedRanges).values({
      id: "merge-parent",
      storyId,
      startIdx: 0,
      endIdx: 1,
      summary: "parent",
      parentRangeId: null,
      createdAt: now,
    });
    await db.insert(compressedRanges).values({
      id: "merge-child",
      storyId,
      startIdx: 0,
      endIdx: 0,
      summary: "child",
      parentRangeId: "merge-parent",
      createdAt: now,
    });
    const before = (await (
      await json(app, "GET", "/api/export/all", undefined, cookie)
    ).json()) as ExportDoc;

    const imported = await importFile(
      app,
      new Blob([JSON.stringify(before)], { type: "application/json" }),
      "?mode=merge",
      cookie,
    );
    expect(imported.status).toBe(200);
    const summary = (await imported.json()) as {
      imported: Record<string, number>;
      skipped: unknown[];
    };
    expect(summary.imported).toMatchObject({
      stories: 1,
      actions: 2,
      cards: 1,
      ranges: 2,
      scripts: 1,
    });
    expect(summary.skipped).toEqual([]);

    const after = (await (
      await json(app, "GET", "/api/export/all", undefined, cookie)
    ).json()) as ExportDoc;
    expect(after.stories).toHaveLength(2);
    const beforeIds = new Set(
      before.stories.flatMap((s) => [s.story.id, ...s.actions.map((a) => a.id)]),
    );
    const afterIds = after.stories.flatMap((s) => [s.story.id, ...s.actions.map((a) => a.id)]);
    // 1 story + 2 actions before, doubled by the merge.
    expect(afterIds).toHaveLength(6);
    const surviving = afterIds.filter((id) => beforeIds.has(id));
    expect(surviving).toHaveLength(3);
    expect(after.stories.map((s) => s.story.title).sort()).toEqual(["Round Trip", "Round Trip"]);
    expect(after.stories.map((s) => s.actions.map((a) => a.text))).toEqual(
      before.stories
        .map((s) => s.actions.map((a) => a.text))
        .concat(before.stories.map((s) => s.actions.map((a) => a.text))),
    );
    // Nested ranges survived with remapped parent links intact.
    for (const s of after.stories) {
      expect(s.ranges).toHaveLength(2);
      const byId = new Map(s.ranges.map((r) => [r.id, r]));
      const children = s.ranges.filter((r) => r.parentRangeId !== null);
      expect(children).toHaveLength(1);
      expect(byId.has(children[0].parentRangeId as string)).toBe(true);
    }
  });

  it("round-trips replace: only imported data exists", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    await seedFullStory(app, cookie, "Doomed");
    await seedFullStory(app, cookie, "Also Doomed");
    const file = (await (
      await json(app, "GET", "/api/export/all", undefined, cookie)
    ).json()) as ExportDoc;
    // Trim the file to one story to prove replacement, not duplication.
    const trimmed = { ...file, stories: [file.stories[0]] };

    const noConfirm = await importFile(
      app,
      new Blob([JSON.stringify(trimmed)], { type: "application/json" }),
      "?mode=replace",
      cookie,
    );
    expect(noConfirm.status).toBe(400);

    const res = await importFile(
      app,
      new Blob([JSON.stringify(trimmed)], { type: "application/json" }),
      "?mode=replace&confirm=DELETE",
      cookie,
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { imported: Record<string, number> };
    expect(summary.imported.stories).toBe(1);

    const after = await await json(app, "GET", `/api/stories`, undefined, cookie);
    // Replace revokes all sessions including the current one.
    expect(after.status).toBe(401);
  });

  it("rejects malformed files and FK violations with reasons", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);

    const notJson = await importFile(app, "this is not json", "?mode=merge", cookie);
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );

    const noVersion = await importFile(
      app,
      new Blob([JSON.stringify({ stories: [] })]),
      "?mode=merge",
      cookie,
    );
    expect(noVersion.status).toBe(400);
    expect(((await noVersion.json()) as { error: { message: string } }).error.message).toContain(
      "version",
    );

    const badFk = await importFile(
      app,
      new Blob([
        JSON.stringify({
          opendungen: 1,
          stories: [
            {
              story: {
                id: "s1",
                title: "t",
                aiInstructions: "",
                plotEssentials: "",
                memory: "",
                summary: "",
                scenarioId: null,
                providerId: null,
                createdAt: 1,
                updatedAt: 1,
              },
              actions: [
                {
                  id: "a1",
                  storyId: "no-such-story",
                  idx: 0,
                  type: "input",
                  text: "hi",
                  createdAt: 1,
                },
              ],
              cards: [],
              ranges: [],
              scripts: [],
              states: [],
            },
          ],
          scenarios: [],
          providerConfigs: [],
        }),
      ]),
      "?mode=merge",
      cookie,
    );
    expect(badFk.status).toBe(400);
    expect(((await badFk.json()) as { error: { message: string } }).error.message).toContain(
      "invalid action",
    );
  });

  it("never imports provider keys, even when present", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const res = await importFile(
      app,
      new Blob([
        JSON.stringify({
          opendungen: 1,
          stories: [],
          scenarios: [],
          providerConfigs: [
            {
              id: "p1",
              label: "sneaky",
              kind: "openai",
              baseUrl: null,
              model: "gpt-x",
              isDefault: true,
              createdAt: 1,
              api_key_enc: "c2VjcmV0LWtleQ==",
            },
          ],
        }),
      ]),
      "?mode=merge",
      cookie,
    );
    expect(res.status).toBe(200);
    const providers = (await (
      await json(app, "GET", "/api/providers", undefined, cookie)
    ).json()) as { providers: { label: string; hasKey: boolean; isDefault: boolean }[] };
    expect(providers.providers).toHaveLength(1);
    expect(providers.providers[0].label).toBe("sneaky");
    expect(providers.providers[0].hasKey).toBe(false);
    expect(providers.providers[0].isDefault).toBe(true);
  });

  it("exports and imports script states", async () => {
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId, scriptId } = await seedFullStory(app, cookie, "Stateful");
    await db.insert(scriptStates).values({
      scriptId,
      storyId,
      state: JSON.stringify({ count: 3 }),
      updatedAt: Date.now(),
    });
    const file = (await (
      await json(app, "GET", "/api/export/all", undefined, cookie)
    ).json()) as ExportDoc;
    expect(file.stories[0].states).toHaveLength(1);

    const res = await importFile(
      app,
      new Blob([JSON.stringify(file)], { type: "application/json" }),
      "?mode=merge",
      cookie,
    );
    expect(res.status).toBe(200);
    const allStates = await db.select().from(scriptStates);
    const counts = allStates.filter((s) => s.state === JSON.stringify({ count: 3 }));
    expect(counts).toHaveLength(2);
  });
});
