import { test, expect } from "../fixtures/test.js";
import { ensureServersForFile, stopServersForFile } from "../fixtures/test.js";
import { ensureAdminAndLogin } from "../fixtures/helpers.js";

test.beforeAll(async ({}, testInfo) => {
  await ensureServersForFile(testInfo.file);
});

test.afterAll(async ({}, testInfo) => {
  await stopServersForFile(testInfo.file);
});

test("instance section renders auth mode and version", async ({ page, api, web }) => {
  await ensureAdminAndLogin(page, api, web);
  await page.goto(`${web}/settings`);
  await expect(page.getByRole("heading", { name: "Instance" })).toBeVisible();
  await expect(page.getByText("Auth mode")).toBeVisible();
  await expect(page.getByText("single", { exact: true })).toBeVisible();
  await expect(page.getByText("Version")).toBeVisible();
});

test("account section shows the current email", async ({ page, api, web }) => {
  await ensureAdminAndLogin(page, api, web);
  await page.goto(`${web}/settings`);
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByText("admin@example.com")).toBeVisible();
});

test("run maintenance shows deleted counts", async ({ page, api, web }) => {
  await ensureAdminAndLogin(page, api, web);
  await page.goto(`${web}/settings`);
  await page.getByRole("button", { name: "Run maintenance now" }).click();
  await expect(page.getByText(/Deleted \d+ sessions, \d+ rate limits/)).toBeVisible();
});
