import { test, expect } from "../fixtures/test.js";
import { ensureServersForFile, stopServersForFile } from "../fixtures/test.js";

test.beforeAll(async ({}, testInfo) => {
  await ensureServersForFile(testInfo.file);
});

test.afterAll(async ({}, testInfo) => {
  await stopServersForFile(testInfo.file);
});

test("fresh instance shows setup; submit creates admin and lands on the wizard", async ({
  page,
  web,
  setupAdmin,
}) => {
  await page.goto(`${web}/`);
  await expect(page.getByRole("heading", { name: "OpenDungen setup" })).toBeVisible();
  await setupAdmin(page);
  await expect(page).toHaveURL(/\/wizard\/step-1$/);
});

test("wrong password shows an error and does not navigate", async ({ page, api, web }) => {
  // The admin already exists (previous test); drop the session so the
  // login screen renders.
  await page.goto(`${web}/`);
  await page.request.post(`${api}/api/auth/logout`);
  await page.goto(`${web}/login`);
  await expect(page.getByRole("heading", { name: "OpenDungen login" })).toBeVisible();
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("invalid email or password")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("sign out returns to login", async ({ page, web }) => {
  await page.goto(`${web}/login`);
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/wizard\/step-1$/);
  // The wizard renders outside the shell (no menu): mark it done so
  // an app view renders instead. Settings uses the shared PageHeader
  // whose menu button is visible at every viewport (the stories
  // screen's own menu button is mobile-only).
  await page.evaluate(() => window.localStorage.setItem("opendungen.wizard.v1", "1"));
  await page.goto(`${web}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "OpenDungen login" })).toBeVisible();
});
