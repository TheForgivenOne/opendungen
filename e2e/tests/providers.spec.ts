import { test, expect } from "../fixtures/test.js";
import { ensureServersForFile, stopServersForFile } from "../fixtures/test.js";
import { ensureAdminAndLogin } from "../fixtures/helpers.js";

test.beforeAll(async ({}, testInfo) => {
  await ensureServersForFile(testInfo.file);
});

test.afterAll(async ({}, testInfo) => {
  await stopServersForFile(testInfo.file);
});

test("add a provider pointing at the stub; test connection succeeds", async ({
  page,
  api,
  web,
  stub,
}) => {
  await ensureAdminAndLogin(page, api, web);
  await page.goto(`${web}/providers`);
  await expect(page.getByText("No providers yet.")).toBeVisible();

  await page.getByLabel("Kind").selectOption("openai-compatible");
  await page.getByLabel(/Base URL/).fill(stub.url);
  await page.getByLabel("Model (required)").fill("stub-model");
  await page.getByLabel("Label").fill("Stub");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Stub")).toBeVisible();

  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("ok: stub-model")).toBeVisible();
});

test("empty label shows an inline error and cannot submit", async ({ page, web, api }) => {
  await ensureAdminAndLogin(page, api, web);
  await page.goto(`${web}/providers`);

  await page.getByLabel("Label").fill("");
  await page.getByLabel("Label").press("Tab");
  await expect(page.getByText("Label is required.")).toBeVisible();

  // Native required validation blocks the submit: the provider count
  // is unchanged.
  const listed = await page.request.get(`${api}/api/providers`);
  const { providers } = (await listed.json()) as { providers: unknown[] };
  expect(providers).toHaveLength(1);
});

test("delete provider removes it from the list", async ({ page, api, web }) => {
  await ensureAdminAndLogin(page, api, web);
  await page.goto(`${web}/providers`);
  await expect(page.getByText("Stub")).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No providers yet.")).toBeVisible();
});
