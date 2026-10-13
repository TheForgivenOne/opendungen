import { test, expect } from "../fixtures/test.js";
import { ensureServersForFile, stopServersForFile } from "../fixtures/test.js";
import { loginAndDismissWizard } from "../fixtures/helpers.js";

test.beforeAll(async ({}, testInfo) => {
  await ensureServersForFile(testInfo.file);
});

test.afterAll(async ({}, testInfo) => {
  await stopServersForFile(testInfo.file);
});

const OPENING = "Dusk settles blue over the crossroads";
const TITLE = "Embers of the Waystation";

test("create story from scenario shows the opening text", async ({ page, web, setupAdmin }) => {
  await setupAdmin(page);
  await page.evaluate(() => window.localStorage.setItem("opendungen.wizard.v1", "1"));
  await page.goto(`${web}/scenarios/new`);
  await page.getByRole("option", { name: /Embers of the Waystation/ }).click();
  await expect(page).toHaveURL(/\/scenarios\/new\/name$/);
  await page.getByLabel("Name your character.").press("Enter");
  await page.waitForURL(/\/stories\/.+$/);
  await expect(page.getByText(OPENING)).toBeVisible();
});

test("story list shows the story; search filters it", async ({ page, web }) => {
  await loginAndDismissWizard(page, web);
  await page.goto(`${web}/stories`);
  await expect(page.getByRole("link", { name: new RegExp(TITLE) })).toBeVisible();

  await page.getByLabel("Search stories").fill("embers");
  await expect(page.getByRole("link", { name: new RegExp(TITLE) })).toBeVisible();
  await page.getByLabel("Search stories").fill("no-such-story-xyz");
  await expect(page.getByText("No stories match your search.")).toBeVisible();
});

test("mark complete moves the story to the Completed tab", async ({ page, web }) => {
  await loginAndDismissWizard(page, web);
  await page.goto(`${web}/stories`);
  await page.getByRole("link", { name: new RegExp(TITLE) }).click();
  await page.waitForURL(/\/stories\/.+$/);
  await page.getByRole("button", { name: "Story settings" }).click();
  await page.locator('[data-drawer-section="story"] > button').click();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByRole("button", { name: "Mark playing" })).toBeVisible();

  await page.goto(`${web}/stories`);
  await page.getByRole("tab", { name: "Completed" }).click();
  await expect(page.getByRole("link", { name: new RegExp(TITLE) })).toBeVisible();
  await page.getByRole("tab", { name: "Playing" }).click();
  await expect(page.getByText("No stories in progress. Start one.")).toBeVisible();
});

test("delete story removes it from the list", async ({ page, web }) => {
  await loginAndDismissWizard(page, web);
  await page.goto(`${web}/stories`);
  await page.getByRole("tab", { name: "Completed" }).click();
  await page.getByRole("link", { name: new RegExp(TITLE) }).click();
  await page.waitForURL(/\/stories\/.+$/);
  await page.getByRole("button", { name: "Story settings" }).click();
  await page.locator('[data-drawer-section="story"] > button').click();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete story" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/stories/"));

  await page.goto(`${web}/stories`);
  await expect(page.getByText("No stories in progress. Start one.")).toBeVisible();
});
