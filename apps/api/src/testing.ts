import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createApp, type AppOptions, type AuthMode } from "./app";
import { getLocalDb, type LocalDb } from "./db.local";
import { scripts, stories, users } from "./db/schema";
import {
  AbortError,
  type LLMChunk,
  type LLMProvider,
  type LLMRequest,
  type ProviderConfigInput,
} from "./llm";

export const TEST_SECRET = "test-session-secret-not-for-production-use";

// Fresh in-memory database with all migrations applied, wired to the app.
// Tests use the local better-sqlite3 driver, never D1.
export function createTestApp(
  authMode: AuthMode = "single",
  overrides: Partial<AppOptions> = {},
): {
  app: ReturnType<typeof createApp>;
  db: LocalDb;
} {
  const db = getLocalDb(":memory:");
  migrate(db, { migrationsFolder: "./drizzle" });
  const app = createApp({ db, authMode, sessionSecret: TEST_SECRET, ...overrides });
  return { app, db };
}

// Extracts "name=value" from a Set-Cookie header for reuse as a Cookie header.
export function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("expected a Set-Cookie header");
  }
  const pair = setCookie.split(";")[0];
  if (!pair.startsWith("opendungen_session=")) {
    throw new Error(`unexpected cookie: ${pair}`);
  }
  return pair;
}

export async function setupAdmin(
  app: ReturnType<typeof createApp>,
  email = "admin@example.com",
  password = "correct-horse-battery-staple",
): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 201) {
    throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: sessionCookie(res), userId: body.user.id };
}

// In-memory test double for LLMProvider. Yields fixed chunks, throws the
// configured error instead when given, and honours abort promptly.
// Never touches the network or any real API.
export interface MockProviderOptions {
  chunks?: string[];
  error?: Error;
  model?: string;
  models?: string[];
}

export function createMockProvider(options: MockProviderOptions = {}): LLMProvider {
  const chunks = options.chunks ?? ["Hello", " world"];
  const error = options.error;
  return {
    kind: "ollama",
    supportsCaching: false,
    supportsMultipleSystemMessages: false,
    tokenMultiplier: 1.0,
    async *complete(_req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk> {
      if (signal.aborted) {
        throw new AbortError();
      }
      if (error) {
        throw error;
      }
      for (const delta of chunks) {
        if (signal.aborted) {
          throw new AbortError();
        }
        yield { delta, done: false };
      }
    },
    async testConnection() {
      return { ok: true as const, model: options.model ?? "mock-model" };
    },
    async listModels() {
      return {
        models: options.models ?? [options.model ?? "mock-model"],
        source: "listing" as const,
      };
    },
  };
}

export function mockProviderFactory(
  options: MockProviderOptions = {},
): (config: ProviderConfigInput) => LLMProvider {
  const provider = createMockProvider(options);
  return () => provider;
}

// Direct DB setup for pipeline tests: a user plus one owned story.
// Returns the ids; stories need a user row for the foreign key.
export async function createStoryRows(
  db: LocalDb,
  overrides: { title?: string } = {},
): Promise<{ userId: string; storyId: string }> {
  const userId = `user-${crypto.randomUUID()}`;
  const storyId = `story-${crypto.randomUUID()}`;
  const now = Date.now();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.com`,
    passwordHash: null,
    instanceAdmin: 0,
    createdAt: now,
  });
  await db.insert(stories).values({
    id: storyId,
    userId,
    scenarioId: null,
    title: overrides.title ?? "Test Story",
    aiInstructions: "",
    plotEssentials: "",
    memory: "",
    summary: "",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    providerId: null,
    compressTriggerPct: null,
    compressMaxTokens: null,
    compressTemperature: null,
    contextTokens: null,
    maxOutputTokens: null,
  });
  return { userId, storyId };
}

// Inserts real script rows so script_states FKs hold in tests that save
// hook state for ad-hoc script ids.
export async function seedScriptRows(db: LocalDb, storyId: string, ids: string[]): Promise<void> {
  const now = Date.now();
  for (const id of ids) {
    await db.insert(scripts).values({
      id,
      storyId,
      scenarioId: null,
      name: id,
      source: "text;",
      enabled: 1,
      position: 0,
      createdAt: now,
    });
  }
}
