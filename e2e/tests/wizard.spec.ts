import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.js";
import { ensureServersForFile, stopServersForFile } from "../fixtures/test.js";
import { loginAsAdmin } from "../fixtures/helpers.js";

test.beforeAll(async ({}, testInfo) => {
  await ensureServersForFile(testInfo.file);
});

test.afterAll(async ({}, testInfo) => {
  await stopServersForFile(testInfo.file);
});

const OPENING = "Dusk settles blue over the crossroads";

async function toProviderStep(page: Page): Promise<void> {
  // Step 1 → 2 → 3 with the default (fantasy) scenario.
  await page.getByRole("option", { name: /Embers of the Waystation/ }).click();
  await expect(page).toHaveURL(/\/wizard\/step-2$/);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/\/wizard\/step-3$/);
}

test("complete wizard end-to-end: scenario, name, provider, story with opening", async ({
  page,
  web,
  stub,
  setupAdmin,
}) => {
  await setupAdmin(page);
  await toProviderStep(page);

  await page.getByLabel("Kind").selectOption("openai-compatible");
  await page.getByLabel(/Base URL/).fill(stub.url);
  await page.getByLabel("Model (required)").fill("stub-model");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("✓ stub-model")).toBeVisible();
  await page.getByRole("button", { name: "Start playing" }).click();

  await page.waitForURL(/\/stories\/.+$/);
  await expect(page.getByText(OPENING)).toBeVisible();
});

test("skip provider step shows the setup banner in the story view", async ({ page, api, web }) => {
  // Fresh browser context: log in (the admin exists from the previous
  // test), then remove its provider so the wizard runs again.
  await loginAsAdmin(page, web);
  const listed = await page.request.get(`${api}/api/providers`);
  const { providers } = (await listed.json()) as { providers: { id: string }[] };
  for (const provider of providers) {
    await page.request.delete(`${api}/api/providers/${provider.id}`);
  }
  await page.goto(`${web}/wizard/step-1`);
  await toProviderStep(page);

  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.waitForURL(/\/stories\/.+$/);
  await expect(page.getByText("Connect a provider to start playing")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
});

test("wizard does not reappear after completion", async ({ page, web }) => {
  await loginAsAdmin(page, web);
  // Simulate a completed wizard: with the flag set the boot gate
  // bounces wizard URLs back into the app.
  await page.evaluate(() => window.localStorage.setItem("opendungen.wizard.v1", "1"));
  await page.goto(`${web}/wizard/step-1`);
  await page.waitForURL((url) => !url.pathname.startsWith("/wizard/"));
  await expect(page).not.toHaveURL(/\/wizard\//);
});
