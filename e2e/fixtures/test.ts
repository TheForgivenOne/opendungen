// Playwright test base for E2E golden paths. Servers live per test
// FILE (fresh SQLite + stub + API + web, torn down in afterAll —
// each spec file calls the hooks explicitly so the lifecycle is
// visible). Fixtures expose the server URLs, the stub controller,
// and UI/API setup helpers.

import { test as base, type Page } from "@playwright/test";
import { startFileServers, type FileServers } from "./app-server.js";
import type { StubMode, StubRequest } from "./stub-provider.js";

const serversByFile = new Map<string, Promise<FileServers>>();

export async function ensureServersForFile(file: string): Promise<FileServers> {
  let pending = serversByFile.get(file);
  if (!pending) {
    pending = startFileServers();
    serversByFile.set(file, pending);
  }
  return pending;
}

export async function stopServersForFile(file: string): Promise<void> {
  const pending: Promise<FileServers> | undefined = serversByFile.get(file);
  serversByFile.delete(file);
  if (pending) {
    const servers = await pending;
    await servers.close().catch(() => undefined);
  }
}

export interface StubController {
  setMode: (mode: StubMode) => void;
  requests: StubRequest[];
  url: string;
}

interface E2EFixtures {
  api: string;
  web: string;
  stub: StubController;
  setupAdmin: (page: Page) => Promise<void>;
  setupProvider: (page: Page) => Promise<void>;
}

async function serversFor(testFile: string | undefined): Promise<FileServers> {
  if (!testFile) {
    throw new Error("E2E fixtures require a test file context");
  }
  return ensureServersForFile(testFile);
}

export const test = base.extend<E2EFixtures>({
  api: async ({}, use, testInfo) => {
    await use((await serversFor(testInfo.file)).apiUrl);
  },
  web: async ({}, use, testInfo) => {
    await use((await serversFor(testInfo.file)).webUrl);
  },
  stub: async ({}, use, testInfo) => {
    const servers = await serversFor(testInfo.file);
    await use({
      setMode: (mode: StubMode) => servers.stub.setMode(mode),
      requests: servers.stub.requests,
      url: servers.stub.url,
    });
  },
  // Completes first-run setup in the browser: fresh instance shows
  // the setup screen, submit creates the admin and lands on the
  // wizard.
  setupAdmin: async ({ web }, use) => {
    await use(async (page: Page) => {
      await page.goto(`${web}/`);
      await page.getByLabel("Email").fill("admin@example.com");
      await page.getByLabel("Password", { exact: true }).fill("password123");
      await page.getByLabel("Confirm password").fill("password123");
      await page.getByRole("button", { name: "Create admin" }).click();
      await page.waitForURL("**/wizard/step-1");
    });
  },
  // Adds a working provider via the API (the UI form itself is
  // covered in providers.spec.ts) and makes it the default so
  // generation works immediately.
  setupProvider: async ({ api }, use, testInfo) => {
    const servers = await serversFor(testInfo.file);
    await use(async (page: Page) => {
      const created = await page.request.post(`${api}/api/providers`, {
        data: {
          label: "Stub",
          kind: "openai-compatible",
          baseUrl: servers.stub.url,
          model: "stub-model",
        },
      });
      if (!created.ok()) {
        throw new Error(`setupProvider create failed: ${created.status()}`);
      }
      const { provider } = (await created.json()) as { provider: { id: string } };
      const madeDefault = await page.request.post(
        `${api}/api/providers/${provider.id}/default`,
        {},
      );
      if (!madeDefault.ok()) {
        throw new Error(`setupProvider default failed: ${madeDefault.status()}`);
      }
    });
  },
});

export { expect } from "@playwright/test";
