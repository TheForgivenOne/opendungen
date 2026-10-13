// Shared route plumbing: the Hono app type and the context object
// each route group receives. Route files destructure what they need
// so handler bodies move verbatim; shared closures (requireAuth,
// currentUser) are bound once in createApp and passed through here.

import type { Hono } from "hono";
import type { AppDb, AppEnv, AuthMode, AuthUser } from "../app";
import type { LLMProvider, ProviderConfigInput } from "../llm";

export type AppRouter = Hono<{ Variables: { user: AuthUser; requestId: string } }>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handlers pass their own route-typed context
export type RouteHandler = (c: any, next: () => Promise<void>) => Promise<Response | void>;

export interface RouteCtx {
  db: AppDb;
  env: AppEnv;
  authMode: AuthMode;
  sessionSecret: string;
  buildProvider: (config: ProviderConfigInput) => LLMProvider;
  requireAuth: RouteHandler;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see requireAuth in app.ts
  currentUser: (c: any) => AuthUser;
}
