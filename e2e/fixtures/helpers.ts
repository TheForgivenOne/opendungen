// Shared E2E helpers (not fixtures: plain functions the specs call).
// Each Playwright test gets a fresh browser context, so authentication
// never carries between tests — log in explicitly wherever needed.

import { expect, request as newRequestContext, type Page } from "@playwright/test";

export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "password123";

export async function loginAsAdmin(page: Page, web: string): Promise<void> {
  await page.goto(`${web}/login`);
  await expect(page.getByRole("heading", { name: "OpenDungen login" })).toBeVisible({
    timeout: 10000,
  });
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("OpenDungen login")).toBeHidden({ timeout: 10000 });
}

export async function ensureAdminAndLogin(page: Page, api: string, web: string): Promise<void> {
  // Idempotent: the second setup attempt 409s (admin exists), which
  // is the expected path for every test after the file's first.
  try {
    await setupAdminAccount(page, api);
  } catch (err) {
    if (!/409/.test(String(err))) {
      throw err;
    }
  }
  await loginAndDismissWizard(page, web);
}

export async function loginAndDismissWizard(page: Page, web: string): Promise<void> {
  await loginAsAdmin(page, web);
  // Fresh contexts have no wizard flag; without it the boot gate
  // bounces every app route back to /wizard/step-1 while no
  // provider exists.
  await page.evaluate(() => window.localStorage.setItem("opendungen.wizard.v1", "1"));
}

export async function setupAdminAccount(page: Page, api: string): Promise<void> {
  // An isolated request context: the setup response sets a session
  // cookie, which must NOT leak into the page's context — auth in
  // tests always happens through the UI login form.
  const ctx = await newRequestContext.newContext();
  try {
    const res = await ctx.post(`${api}/api/auth/setup`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(`admin setup failed: ${res.status()}`);
    }
  } finally {
    await ctx.dispose();
  }
}

export interface ApiStory {
  id: string;
  title: string;
}

export async function createStoryApi(
  page: Page,
  api: string,
  title: string,
  scenarioId?: string,
): Promise<ApiStory> {
  const res = await page.request.post(`${api}/api/stories`, {
    data: { title, ...(scenarioId ? { scenarioId } : {}) },
  });
  if (!res.ok()) {
    throw new Error(`create story failed: ${res.status()}`);
  }
  const { story } = (await res.json()) as { story: ApiStory };
  return story;
}

export async function listStoriesApi(
  page: Page,
  api: string,
): Promise<{ stories: { id: string; title: string }[] }> {
  const res = await page.request.get(`${api}/api/stories`);
  if (!res.ok()) {
    throw new Error(`list stories failed: ${res.status()}`);
  }
  return (await res.json()) as { stories: { id: string; title: string }[] };
}
