# OpenDungen

OpenDungen is a self-hostable, AI Dungeon–style text adventure app: an original
implementation modeled on AI Dungeon's observable behavior (no AI Dungeon code,
prompts, assets, or text are used), where the player writes what their character
does and an AI narrator writes what happens next.

## Stack

- Frontend: Vite + React + TypeScript + Tailwind CSS v4 (`apps/web`)
- Backend: Hono running on Cloudflare Workers (`apps/api`), or on Node 22
  via the built entry point (`apps/api/dist/node.js`)
- DB: SQLite via libSQL with Drizzle ORM, dual driver — Cloudflare D1 in
  production, file-backed SQLite via better-sqlite3 for local Node self-hosting
- Shared story model: TypeScript interfaces (`packages/shared`)
- Package manager: pnpm workspaces, Node 22 LTS

## Deploy to Cloudflare (recommended)

1. Log in to Cloudflare:
   ```sh
   wrangler login
   ```
2. Create the production database:
   ```sh
   wrangler d1 create opendungen
   ```
3. Paste the returned `database_id` into the `[env.production]` block of
   `apps/api/wrangler.toml` (replacing `"REPLACE_ME"`), then apply the
   schema:
   ```sh
   cd apps/api
   wrangler d1 migrations apply DB --remote --env production
   ```
   (The same `./drizzle` folder serves local dev with `--local`, tests via
   the better-sqlite3 migrator, and production with `--remote` — one
   migration history everywhere.)
4. Set the production secret (never commit it):
   ```sh
   wrangler secret put SESSION_SECRET --env production
   ```
   Optional vars are documented in `apps/api/wrangler.toml` and
   `apps/api/.dev.vars.example`: `RATE_LIMIT_ENABLED`,
   `ALLOW_PRIVATE_PROVIDER_URLS`, `CORS_ORIGINS`, `LOG_LEVEL`,
   `SENTRY_DSN` (reserved hook only — no Sentry SDK ships),
   `INSTANCE_SCRIPTS_ENABLED`.
5. Deploy everything from the repo root:
   ```sh
   pnpm deploy
   ```
6. Visit the deploy URL → first-run wizard: create the instance admin
   account, add an LLM provider, pick a scenario, and play.

## Self-host on a Node server

Requires Node 22 and a writable directory for the SQLite file.

1. Configure the environment:
   ```sh
   DB_DRIVER=local DB_PATH=/var/lib/opendungen/db.sqlite \
     SESSION_SECRET=<random 32 bytes, e.g. from `openssl rand -hex 32`>
   ```
   (`SESSION_SECRET` signs sessions and derives provider-key encryption —
   rotating it invalidates both. `AUTH_MODE` defaults to `single`;
   `PORT` defaults to `8787`; `RUN_MIGRATIONS_ON_BOOT=true` applies the
   `./drizzle` schema on boot.)
2. Build:
   ```sh
   pnpm -r build
   ```
3. Run the API (same Hono app as the Worker, on better-sqlite3 via
   `@hono/node-server`):
   ```sh
   DB_DRIVER=local DB_PATH=/var/lib/opendungen/db.sqlite \
     SESSION_SECRET=<secret> RUN_MIGRATIONS_ON_BOOT=true pnpm start
   ```
   or directly: `node apps/api/dist/node.js`. Exits cleanly on SIGTERM.
4. Serve the frontend build with any static server, or run
   `pnpm --filter web preview`:
   ```sh
   pnpm --filter web build
   ```

Local development (Workers emulation + Vite) is unchanged:

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars  # then set SESSION_SECRET
cd apps/api && pnpm exec wrangler d1 migrations apply DB --local && cd ../..
pnpm dev
```

- API: http://localhost:8787/api/health (IPv4 loopback; `curl
  http://127.0.0.1:8787/...` works too)
- Web: http://localhost:5173 (proxies `/api` to the worker)

Other commands: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`,
`pnpm -r build`.

## Testing

- `pnpm test` — unit and integration tests (vitest, per package).
- `pnpm e2e` — end-to-end golden paths (Playwright, headless
  Chromium): 21 tests across auth, wizard, stories, generation,
  settings, and providers, each file against a fresh temp database
  with a stub LLM (no real providers). First run needs
  `npx playwright install chromium`.
- `pnpm e2e:ui` — the same suite in the interactive Playwright UI
  runner.

## Operations

- **Rate limiting**: sliding 60s windows on generate/retry (60/min),
  provider test (20/min), import/login (10/min), and setup (5/min);
  over limit answers 429 with `Retry-After`. Set
  `RATE_LIMIT_ENABLED=false` if you rate-limit at your own proxy.
- **Maintenance**: no cron ships. Call `POST /api/admin/cleanup` (instance
  admin only, except `AUTH_MODE=none`) from your own scheduler — it
  deletes expired sessions, stale rate-limit rows, orphaned script
  states, and invalid ranges, and returns per-table counts. The settings
  screen has a "Run maintenance now" button for admins.
- **Observability**: one JSON log line per request
  (`method/path/status/durationMs/requestId/userId?/ip?`); every error
  response carries a `requestId` that is also echoed as the
  `X-Request-Id` response header. Set `LOG_LEVEL=debug` for verbose
  output. `SENTRY_DSN` is reserved for future error-reporting wiring.
- **Split deployments**: set `CORS_ORIGINS` (comma-separated) to let a
  separately hosted frontend call `/api/*` with credentials. Unset
  means same-origin only.
- **Local LLMs**: provider URLs pointing at localhost/LAN are rejected
  by default (SSRF protection). Set `ALLOW_PRIVATE_PROVIDER_URLS=true`
  to allow them (e.g. Ollama at `http://127.0.0.1:11434`).

## LLM provider note

OpenDungen ships with **no default LLM provider or model**. Self-hosters add
their own via the Providers screen (OpenAI, Anthropic, Ollama, or any
OpenAI-compatible endpoint); per-user API keys are encrypted with AES-GCM
before storage. The encryption key derives from `SESSION_SECRET` via
HKDF — **rotating `SESSION_SECRET` invalidates all stored provider keys**
(and all sessions), so affected providers must be re-entered.

## Troubleshooting

- `Missing SESSION_SECRET`: set it in `apps/api/.dev.vars` (dev),
  via `wrangler secret put SESSION_SECRET` (Cloudflare), or in the
  environment (Node).
- Provider creation rejects `http://127.0.0.1:11434` (or any LAN URL):
  set `ALLOW_PRIVATE_PROVIDER_URLS=true`.
- Scripts never run / turns behave as if no scripts exist: check
  `INSTANCE_SCRIPTS_ENABLED` is not `false` — that flag disables the
  Scripts engine entirely. If your Workers build cannot load the
  QuickJS WASM (loading it on real Cloudflare Workers is still
  unverified, see PROGRESS.md), set `INSTANCE_SCRIPTS_ENABLED=false`:
  script hooks are skipped, generation works normally, and one warning
  is logged at boot.
- `429 rate_limited` on login/setup: wait for the `Retry-After`
  window, or set `RATE_LIMIT_ENABLED=false` behind your own proxy.
