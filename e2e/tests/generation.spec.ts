import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.js";
import { ensureServersForFile, stopServersForFile } from "../fixtures/test.js";
import { createStoryApi, loginAndDismissWizard, setupAdminAccount } from "../fixtures/helpers.js";

test.beforeAll(async ({}, testInfo) => {
  await ensureServersForFile(testInfo.file);
});

test.afterAll(async ({}, testInfo) => {
  await stopServersForFile(testInfo.file);
});

const STUB_TEXT = "This is a test generation response.";

let provisioned = false;
let storyId = "";

interface ApiAction {
  idx: number;
  type: string;
  text: string;
}

async function readActions(page: Page, api: string): Promise<ApiAction[]> {
  const res = await page.request.get(`${api}/api/stories/${storyId}/actions`);
  if (!res.ok()) {
    throw new Error(`read actions failed: ${res.status()}`);
  }
  const { actions } = (await res.json()) as { actions: ApiAction[] };
  return actions;
}

async function ensureWorld(page: Page, api: string, web: string, stubUrl: string): Promise<void> {
  await setupAdminAccount(page, api).catch(() => undefined);
  await loginAndDismissWizard(page, web);
  if (provisioned) {
    return;
  }
  const created = await page.request.post(`${api}/api/providers`, {
    data: {
      label: "Stub",
      kind: "openai-compatible",
      baseUrl: stubUrl,
      model: "stub-model",
    },
  });
  if (!created.ok()) {
    throw new Error(`provider setup failed: ${created.status()}`);
  }
  const { provider } = (await created.json()) as { provider: { id: string } };
  await page.request.post(`${api}/api/providers/${provider.id}/default`, {});
  const story = await createStoryApi(page, api, "E2E Tale", "builtin-fantasy-waystation");
  storyId = story.id;
  provisioned = true;
}

async function openStory(page: Page, web: string): Promise<void> {
  await page.goto(`${web}/stories/${storyId}`);
  await expect(page.getByText("Dusk settles blue")).toBeVisible();
}

async function sendInput(page: Page, text: string): Promise<void> {
  await page.getByLabel("What do you do?").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("do input streams output that persists across reload", async ({ page, api, web, stub }) => {
  await ensureWorld(page, api, web, stub.url);
  await openStory(page, web);

  await sendInput(page, "look around");
  await expect(page.getByText(STUB_TEXT)).toBeVisible();

  await page.reload();
  await expect(page.getByText(STUB_TEXT)).toBeVisible();
  await expect(page.getByText("You look around")).toBeVisible();
});

test("retry regenerates the last output", async ({ page, api, web, stub }) => {
  await ensureWorld(page, api, web, stub.url);
  await openStory(page, web);
  const before = stub.requests.filter((r) => r.url === "/v1/chat/completions").length;

  // Retry deletes the old output before regenerating: the log length
  // is unchanged, but the stub sees exactly one new request.
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .poll(async () => stub.requests.filter((r) => r.url === "/v1/chat/completions").length, {
      timeout: 15000,
    })
    .toBe(before + 1);
  const actions = await readActions(page, api);
  expect(actions).toHaveLength(3);
  expect(actions[actions.length - 1]).toMatchObject({ type: "output", text: STUB_TEXT });
});

test("undo removes the last pair", async ({ page, api, web, stub }) => {
  await ensureWorld(page, api, web, stub.url);
  await openStory(page, web);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await readActions(page, api)).length, { timeout: 15000 }).toBe(1);
  await expect(page.getByText("You look around")).toBeHidden();
  await expect(page.getByText("Dusk settles blue")).toBeVisible();
});

test("esc aborts the stream: input kept, no output", async ({ page, api, web, stub }) => {
  await ensureWorld(page, api, web, stub.url);
  stub.setMode("slow");
  try {
    await openStory(page, web);
    await sendInput(page, "run away");
    // First slow chunk arrives; abort mid-stream.
    await expect(page.getByText("This is a test")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
    await expect(page.getByText("Generation failed")).toBeHidden();
    await expect(page.getByText("You run away")).toBeVisible();

    await page.reload();
    await expect(page.getByText("You run away")).toBeVisible();
    await expect(page.getByText("This is a test")).toBeHidden();
    const actions = await readActions(page, api);
    // The only output is the seeded opening (idx 0): the aborted
    // turn persisted its input and nothing else.
    expect(actions.filter((a) => a.type === "output")).toHaveLength(1);
    expect(actions.filter((a) => a.type === "input")).toHaveLength(1);
  } finally {
    stub.setMode("stream");
  }
});

test("empty stub output shows an inline error and persists no output", async ({
  page,
  api,
  web,
  stub,
}) => {
  await ensureWorld(page, api, web, stub.url);
  stub.setMode("empty");
  try {
    await openStory(page, web);
    const actionsBefore = await readActions(page, api);

    await sendInput(page, "listen carefully");
    await expect(
      page.getByText("Generation failed: The model returned no output. Try again."),
    ).toBeVisible();

    await page.reload();
    const actions = await readActions(page, api);
    expect(actions).toHaveLength(actionsBefore.length + 1);
    expect(actions[actions.length - 1]).toMatchObject({ type: "input" });
    expect(actions.filter((a) => a.type === "output")).toHaveLength(
      actionsBefore.filter((a) => a.type === "output").length,
    );
  } finally {
    stub.setMode("stream");
  }
});
