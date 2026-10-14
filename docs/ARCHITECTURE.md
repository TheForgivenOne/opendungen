# OpenDungen — Architecture (Phase 1)

## Stack and why

- **Vite + React + Tailwind v4** (`apps/web`): static frontend, no router
  or state library; one view-state plus `fetch` is enough for CRUD UI.
- **Hono on Cloudflare Workers** (`apps/api`): tiny edge runtime, all
  routes return JSON shaped `{ error: { code, message } }` on failure.
- **SQLite via Drizzle, dual driver**: Cloudflare D1 in production,
  file-backed better-sqlite3 for local Node. One `./drizzle` migration
  history serves D1 (`wrangler d1 migrations apply`), local dev
  (`--local`), and tests (better-sqlite3 migrator on `:memory:`).
- **pnpm workspaces, Node 24, TypeScript only.** No default LLM provider
  or model anywhere in the repo.

## Data model summary

Nine tables, all keyed by text ids (`crypto.randomUUID()`, except seeds).
Users own stories, provider configs, and sessions; stories own actions
(ordered by server-assigned monotonic `idx`, unique per story), story
cards (keyword `keys` + `entry` text, JSON-encoded keys), and compressed
ranges (nested via self-referencing `parent_range_id`). Scenarios are
standalone templates (3 seeded builtins); stories optionally point at
one. Soft delete is a `deleted_at` timestamp — list queries exclude it,
all other reads treat deleted as missing. `rate_limits` backs the
Phase 5 sliding-window limiter (one row per key). Required indexes cover every foreign-key lookup path
(`actions(story_id, idx)`, `stories(user_id, deleted_at)`, etc.).
Phase 4 adds: `scenarios.user_id` (null = builtin read-only, non-null =
user-owned editable), `stories.provider_id` (persistent provider
override, `ON DELETE SET NULL`), and five nullable per-story overrides
(`compress_trigger_pct`, `compress_max_tokens`, `compress_temperature`,
`context_tokens`, `max_output_tokens`) that fall back to the shared
constants field by field, plus a nullable `completed_at` completion
marker (Phase 6b, null = playing).

## Auth model

`AUTH_MODE` (`none` | `single` | `multi`, default `single`). `none`
skips auth — every request acts as a lazily-provisioned instance admin.
`single` is first-run setup: `POST /api/auth/setup` creates the ONE
admin (409 afterwards), then email+password login. `multi` is reserved
and answers 501 on every API route except `/api/health`. Sessions are
DB rows (`sessions.id`, `user_id`, `expires_at`) referenced by a signed
JWT (`jose`, HS256, 30-day expiry) in the `opendungen_session` cookie
(httpOnly, SameSite=Lax, `Secure` only over HTTPS so local HTTP dev
works); logout deletes the row and clears the cookie. Passwords are
scrypt via `@noble/hashes` (pure JS — argon2 cannot run on Workers):
N=16384, r=8, p=1, 32-byte hash, 16-byte salt, format
`scrypt$N=…$r=…$p=…$<salt-hex>$<hash-hex>`. The JWT secret is
`SESSION_SECRET` (wrangler secret in prod, `.dev.vars` locally).

## Story model

A story is a flat append-only action log (`input` | `output` |
`continue`), never a tree: retry/undo/edit mutate the log in later
phases. Compressed ranges are a *view* over the log — nested summaries
with `start/end_idx` — while the full log is always retained. Cards are
plain data this phase (no trigger evaluation).

## Context budget defaults

See `packages/shared/src/story.ts` (frozen): 8192 total tokens, 70%
required cap, dynamic split 25% cards / 50% history / 25% memory, 60%
compress trigger, 400 max output tokens, last 3 history entries never
compressed. The assembler (`apps/api/src/context/assemble.ts`) also uses
them for card triggering (last 3 actions + new input) and the history cap.

## Provider abstraction (Phase 2a)

One `LLMProvider` interface (`apps/api/src/llm/`): `complete()` streams
`{ delta, done }` chunks honouring an AbortSignal (abort throws a typed
`AbortError`); `testConnection()` probes credentials. Four adapters:

- **openai** — `openai` SDK; prefix caching is automatic past ~1024 tokens.
- **anthropic** — `@anthropic-ai/sdk`; explicit `cache_control` breakpoint
  on the stable system prefix (`cachePrefixUpTo`).
- **ollama** — plain fetch to `{baseUrl}/api/chat` (NDJSON), keyless OK.
- **openai-compatible** — plain fetch to `{baseUrl}/v1/chat/completions`
  (SSE); caching off (unknown server semantics).

### Ollama

Local servers and Ollama Cloud share one adapter and one provider
kind — cloud vs local is derived from the baseUrl at runtime
(`isOllamaCloud`: host `ollama.com` or a subdomain of it). The API
surface is identical on both (`/api/chat` NDJSON stream, `/api/tags`
listing, `prompt_eval_count` / `eval_count` usage on the final
`done: true` line); only auth differs: cloud sends
`Authorization: Bearer <apiKey>` on every request (chat, listing,
testConnection), local sends no Authorization header. A cloud row
without a key is rejected on create and PATCH
(`ollama_cloud_key_required`). SSRF keeps two narrow ollama-only
exceptions: `https://ollama.com` bypasses the check entirely (public
by definition), and the two literal local defaults
(`http://localhost:11434`, `http://127.0.0.1:11434`) are always
allowed without `ALLOW_PRIVATE_PROVIDER_URLS`; any other private
address still requires the flag, and no other kind is loosened.
`/v1/responses` and the Anthropic-compatible endpoint are
deliberately not implemented — cloud works through the same
`/api/*` paths as local.

All map 401/429/404 to typed `auth` / `rate_limit` / `model_not_found`
errors, network failures to `network`, bad payloads to `malformed`.

## Prompt architecture (Phase P)

Every turn sends a layered prompt with a fixed place and purpose
per layer. `apps/api/src/context/prompts.ts` is the single source
of truth for the fixed wording — the assembler decides placement
and trimming, never wording. **Prompt changes must be evaluated
with `pnpm --filter api eval-prompt` before merging.**

1. **BASE SYSTEM PROMPT** (always, first): two sentences —
   masterful storyteller/gamemaster, second person present tense
   (Latitude's Harbinger-24B system prompt, research-backed).
2. **OUTPUT CONSTRAINTS** (always, immediately after): seamless
   continuation (no recap), **120–180 words** (a hard numerical
   target — vague terms like "concise" do not work), player
   agency (world/NPCs/consequences only), one non-sight sensory
   detail, end on a hook, no repetition, honest failure, match
   scenario tone.
3. **SCENARIO INSTRUCTIONS** (per scenario, may be empty):
   appended after the constraints with no header. Contract: may add
   tone, setting rules, genre constraints, content boundaries,
   character voice guidance; may NOT override the length target,
   player agency rules, anti-summarization, or the hook constraint.
4. **MODE DIRECTIVE** (per turn): `do` narrates the outcome first;
   `say` responds in character as the addressee; `story` continues
   player prose seamlessly without acknowledging it; `continue`
   advances the scene without resolving open conflict.
5. **PLOT ESSENTIALS** (`Plot Essentials:\n...`): user-written
   permanent facts.
6. **STORY SUMMARY** (`Story Summary:\n...`): auto-generated,
   floored at 100 tokens.
7. **STORY CARDS** (`World Lore:\n...`, max 5, enabled only,
   whole-word key match on the last 3 actions + new input).
   Recommended NPC format (community guidance, free text, no
   validation — there is no card editor UI in v1, cards are
   API-only): `FULL_NAME is a GENDER RACE JOB with
   PHYSICAL_DETAIL. NAME is PERSONALITY and PERSONALITY. NAME is
   RELATIONSHIP. NAME feels EMOTION about PAST_EVENT.`
8. **RECENT HISTORY**: verbatim turns oldest-first (input → user,
   output/continue → assistant), newest-first fill within the
   history budget; the last action always ships. Compressed ranges
   substitute per the Phase 2c rules (unchanged).
9. **AUTHOR'S NOTE** (`Author's Note: [memory]`): the `memory`
   field, square-bracketed, as a system message AFTER history and
   BEFORE the input (AI Dungeon placement). Short-term directives
   only (tone reminders, style corrections, scene directives —
   under 4 sentences); permanent facts belong in Plot Essentials.
   Omitted entirely when empty.
10. **CURRENT INPUT**: `> ${text}` for do/say (already
    client-transformed), raw text for story, and no user message at
    all for continue.

Layers 1–7 are separate system messages and form the stable,
cacheable prefix (`cachePrefixUpTo` = index of the last stable
system message — cards, else summary, else plot, else the mode
directive). Switching modes between turns invalidates the cache;
within one mode it holds. Providers that reject multiple system
messages (`supportsMultipleSystemMessages`, false for
openai-compatible and ollama, true for openai and anthropic) get
all system blocks joined with `\n\n` into one leading system
message instead (cache breakpoint 0). The Anthropic adapter folds
all leading system messages into its `system` array with the cache
breakpoint on the last stable block.

Token estimate is `chars/4 × provider.tokenMultiplier` (rough, no
tokenizer). The required layer (base + constraints + scenario +
mode + plot + summary + memory) counts against the 70% cap and is
never trimmed below its fixed layers: trim story cards first, then
memory, then summary (floor 100 tokens), then plot essentials.
Base, constraints, scenario instructions, and the mode directive
are never trimmed under any circumstance; neither is the last
action. The dynamic 30% still splits cards 25% / history 50% /
memory 25% (memory is pre-capped to its share). Every turn still
returns `{ messages, usage, cardsInjected, rangesApplied }` as an
audit.

The eval harness (`apps/api/scripts/eval-prompt.ts` +
`eval-cases.json`, 10 cases: three openings, dialogue, failure,
continue, long-context continuity, tone drift, agency, length)
builds contexts through the real assembler and drains one
non-streamed call per case (temperature 0.8, per-case maxTokens)
into `scripts/eval-output/<timestamp>/` (`<case>.txt` +
`summary.md` for reading). It never touches the database or a real
story, asserts nothing, and runs outside CI. Length compliance is a
known LLM limitation: if the model misses 120–180 words, report it
— do not retune the prompt without an evaluation round.

## Generation SSE shape

`POST /api/stories/:id/generate` (body `{ input, providerId? }`, or
`{ continue: true }` with no input) and
`/retry` (optional body `{ providerId?, restoreRangeIds? }`) stream: `meta { usage, cardsInjected, inputActionId }`, then
`delta { text }` chunks, then `done { outputActionId, usage }` — or
`error { code, message }`. When scripts report errors, a final
`script_errors { errors: [{ scriptId, name, message }] }` follows `done`
(absent when there are none). Success persists input at idx N + output
at N+1; abort keeps only the input; other errors persist nothing. Retry
deletes the old output before regenerating (no history of attempts);
undo deletes the last input+output pair (or a lone aborted input).
Phase 6b `continue: true` skips the input action and the input-hook,
generates from context alone (`newInput` omitted from assembly, so no
trailing user message), persists only the output at max+1, and reports
`inputActionId: null` in meta. Retry on an output with no preceding
input (a continued output) deletes it and regenerates the same way;
undo after a continue deletes only the output.

## Compression (Phase 2c)

DCP-style and LLM-driven: after a successful turn (input + output
persisted) the server checks `estimatedTokens(story layers + full
action log) >= 60% of 8192`. When true, a compression attempt runs in
the SSE tail — after `done` is emitted, so visible output is never
delayed — and every failure is logged and swallowed: compression never
blocks or fails a turn.

The compressor (`apps/api/src/context/compress.ts`) is a **separate,
non-streamed LLM call** (maxTokens 600, temperature 0.2), never a tool
call inside the narrative stream — streaming narrative output must
never be polluted by tool calls. The user message is a compact digest:
`Story: <title>`, one `[range:A-B] <summary>` line per existing range
(ranges keep priority), then one `[idx] <type>: <text ≤200 chars>` line
per uncovered action, capped at 4000 tokens by dropping the oldest raw
actions first. The response must be strict JSON
`{shouldCompress, startIdx, endIdx, summary}`; anything else means no
compression, with no retry.

Persistence validates: integer bounds with startIdx < endIdx inside the
log, never covering the last 3 actions. A new range fully containing
existing ones nests under the outermost contained range
(`parentRangeId`); a range inside an existing one nests under its
innermost container; partial overlaps are rejected. Actions are never
deleted or modified — compression is a view, `actions` stays the source
of truth. Success logs one debug line (ids, idxs, summary token count).

Restore is per-turn and client-supplied, never persisted: generate and
retry accept `restoreRangeIds`, validated so every id belongs to the
story (else 400). `DELETE /api/ranges/:rangeId` (auth + ownership)
unlinks children (sets their `parentRangeId` to null — no cascade
delete) and removes the range; the covered actions were never touched
and reappear immediately, with surviving children re-surfacing per the
nesting rules.

## Scripts engine (Phase 2b)

User scripts attach to exactly one story or scenario (`scripts` table,
one owner enforced by CHECK; per-script per-story JSON state in
`script_states`). Hook points: input (rewrite player text), context
(rewrite layers before assembly), output (rewrite persisted text).
Each turn runs enabled scenario scripts in position order, then enabled
story scripts in position order, through one QuickJS runtime per hook
invocation (never reused across requests). The QuickJS WASM module is
built once per isolate from a vendored, bundle-time-compiled
`WebAssembly.Module` (`newVariant(RELEASE_SYNC, { wasmModule })`, the
documented Cloudflare Workers pattern — runtime fetching/compilation
is forbidden in the isolate); vitest aliases the same bytes via
`qjs-wasm.vitest.ts`.

Sandbox surface — exactly `state`, `text` (input/output hooks),
`context` (context hook, a mutable snapshot of the five layers),
`log(msg)` (server debug log only), and `history` (frozen last-10
`{ type, text }` array). Scripts run at every hook and guard on which
globals are defined. Math.random is a deterministic PRNG seeded with
storyId + action idx; Date is removed. Limits: 200ms timeout via
interrupt handler, 2 MB runtime memory, 64 KB state per script per
story (oversize keeps the old state). Errors are per-script and
non-fatal: a failing script is skipped, collected into
`ScriptResult.errors`, and surfaced via the `script_errors` SSE event.
State changes persist after each hook, so later hooks in the same turn
see them.

The WASM module loads lazily: `qjs-module.ts` dynamic-imports the
vendored bytes on the first `getSandboxQuickJS()` call and caches the
instantiation in module scope. Hook runners return early when a story
has no scripts, so scriptless turns never touch the module; the
bundle-time `newVariant(RELEASE_SYNC, { wasmModule })` strategy is
unchanged, only deferred.

`INSTANCE_SCRIPTS_ENABLED=false` makes scripts a no-op (one warning
per isolate): turns load no scripts and no states, validation refuses,
and generate works normally — a deploy whose Workers build cannot load
the WASM still functions. Default `true`.

Production caveat: the `newVariant` pattern is proven under local
workerd only. Loading QuickJS WASM on real Cloudflare Workers is
**UNVERIFIED** — it needs a real deploy with credentials (none exist
in this environment). If it fails in production, the fallback is the
`INSTANCE_SCRIPTS_ENABLED=false` flag above, which is implemented and
tested.

Streamed vs persisted output: the output hook runs only on success,
after the full output has streamed. Deltas go to the client as-is; the
hook result is what gets persisted. On abort the output hook never runs.

The sandbox must NEVER have: fetch, XMLHttpRequest, require, import,
setTimeout, setInterval, console, process, Date, or any globalThis
power beyond the five bindings above (verified by tests probing each).

## Import / export

`GET /api/export/story/:id` and `GET /api/export/all` return a
versioned JSON document (`Content-Disposition: attachment`):
`{ opendungen: 1, exportedAt: <unix ms>, stories: [{ story, actions,
cards, ranges, scripts, states }], scenarios: [...], providerConfigs:
[...] }`. Single-story exports carry only `{id, title}` refs for the
referenced scenario; full exports carry complete user-owned scenarios
plus refs for referenced builtins. Soft-deleted stories are excluded.
`providerConfigs` never contain `api_key_enc` — not even with
`?includeKeys=true` (accepted, warned, still omitted).

`POST /api/import` takes multipart `file` plus `?mode=merge` (default)
or `?mode=replace&confirm=DELETE`. Validation rejects unknown versions,
malformed JSON, and any dangling in-file FK with a 400 reason. Import
regenerates every id and remaps foreign keys: scenario refs resolve
against live rows (else unlinked with a reason), story provider ids
remap (else default with a reason), out-of-range override values reset
with reasons, non-JSON script states reset with reasons. Provider keys
are never imported even when present — imported configs store an empty
key for re-entry. Merge preserves existing defaults unless the file
marks one; replace deletes all user data first (stories cascade,
user scenarios cascade, providers, and all sessions including the
current one — replace ends logged out) while builtins and the user row
survive. The response is `{ imported: {counts}, skipped: [{entity,
reason}] }`; the file's user identity is never imported — everything
attaches to the caller.

## Scenario authoring

`POST /api/scenarios` creates a user-owned scenario
(`{title, description, opening, aiInstructions, tags}`);
`PATCH`/`DELETE /api/scenarios/:id` edit and delete it (403 on
builtins, which have null `user_id`); delete unlinks stories
(`scenario_id` → null, stories survive) and cascades to scenario
scripts via the foreign key. `POST /api/scenarios/:id/duplicate`
copies any scenario's fields — including builtins — into a new
user-owned row (scripts stay with the original). In single-user modes
editability is exactly `!builtin`, so the list/detail shapes are
unchanged. The Scenarios screen adds a New-scenario modal, Edit/Delete
actions on owned cards, Duplicate on builtins, an editor form
(comma-separated tags) on owned detail views, and Duplicate-to-edit on
builtin detail views.

## Per-story settings

`PATCH /api/stories/:id` accepts a persistent `providerId` (string or
null; must be an owned provider) plus five nullable numeric overrides
(`context_tokens` 2048–200000, `max_output_tokens` 100–4000,
`compress_trigger_pct` 0.3–0.95, `compress_max_tokens` 200–2000,
`compress_temperature` 0–1; out-of-range is a 400, null resets to the
constant). Turns resolve the provider as one-off body `providerId` >
story override > current default, for generate and retry alike — retry
stores no per-action provider, so a story with an override retries on
the override and one without retries on the current default. Deleting
the override provider fires `ON DELETE SET NULL` and the story reverts
to the default. Context assembly and provider `maxTokens` use the
effective budget; the compression trigger and compressor call use the
effective compressor params. The story view exposes a provider dropdown
("Default (X)" or a specific provider) and an Advanced collapsible
with the five numeric inputs, effective values, and Reset to defaults.

## Security

**Rate limiting** (`apps/api/src/rate-limit.ts`) covers only the
expensive endpoints, keyed by user id when a session resolves else by
`CF-Connecting-IP` (or the first `X-Forwarded-For` hop):
generate/retry 60/min, provider test 20/min, import and login 10/min,
setup 5/min. Sliding 60s windows, one `rate_limits` row per key,
UPSERT per request; over limit answers 429 with a `Retry-After`
header. `RATE_LIMIT_ENABLED=false` skips it entirely (self-hosters
behind their own proxy). Stale rows (>2 min) are deleted lazily on
every check — no cron.

**SSRF** (`apps/api/src/llm/ssrf.ts`): provider `baseUrl` is
user-controlled and fetched server-side, so `assertPublicUrl` runs on
create, on PATCH when `baseUrl` changes, and in the test-connection
route before any fetch. It enforces http(s) scheme, rejects embedded
credentials, requires literal-IP hosts to be public, and resolves
hostnames (Node DNS, else DNS-over-HTTPS in the isolate) rejecting any
answer in RFC1918/loopback/link-local/unique-local/metadata/
unspecified/multicast/broadcast space — fail closed on unresolvable
hosts. `ALLOW_PRIVATE_PROVIDER_URLS=true` skips the private-IP checks
for local Ollama (one warning is logged when enabled).

**CSRF**: sessions are SameSite=Lax cookies, plus belt-and-braces —
POST/PATCH/DELETE must carry an `Origin` (or `Referer` fallback)
matching the request's own origin, else 403. setup/login are exempt
(first-request flows carrying no cookie yet); requests with neither
header (curl, native apps) pass, since browsers always send Origin on
mutating fetches. Origins listed in `CORS_ORIGINS` are trusted as
well (split deployments mutate cross-origin by design); the dev Vite
proxy rewrites `Origin` to the API origin so local development behaves
as same-origin.

**Headers**: every response carries a CSP (`default-src 'self'`, Tailwind
needs `style-src 'unsafe-inline'`, `frame-ancestors 'none'`), `nosniff`,
`DENY`, strict-origin-when-cross-origin referrer, and an empty
permissions policy. Outside production (`NODE_ENV !== "production"`)
`connect-src` also allows the Vite dev server + HMR websocket.

**Body limits**: 1 MB on mutating API requests (declared
Content-Length rejected unread; otherwise a clone is measured),
except `POST /api/import` at 64 MB for backup files. Over limit is 413.

**CORS**: unset `CORS_ORIGINS` means same-origin only (no CORS
headers). When set (comma-separated), those origins may call `/api/*`
(GET/POST/PATCH/DELETE) with credentials — for split deployments.

## Observability

Structured logs (`apps/api/src/log.ts`): one JSON object per stdout
line — `{ ts, level, msg, requestId?, ...safe fields }` — at
`debug/info/warn/error`, gated by `LOG_LEVEL` (default `info`, Worker
env pushed in via `setLogLevel`). Never logged: keys, prompts,
completions, session tokens, request bodies — and request lines carry
only `c.req.path`, never the query string. Every request gets a
request id (incoming `X-Request-Id` honoured, else a UUID), echoed
back in the response header, attached to its log lines, and included
in every JSON error as `{ error: { code, message, requestId } }`
(injected by middleware, so all existing error paths comply). Request
lines log `{ method, path, status, durationMs, requestId, userId?,
ip? }`; `onError` logs name + message with the id. `SENTRY_DSN` is a
reserved, documented hook only — no Sentry SDK ships (its v11
Cloudflare root has no usable runtime `init`; wiring it is future
work, gated on the env var when it lands).

## Maintenance

`apps/api/src/maintenance.ts` exports `cleanup(db)` — deletes expired
sessions, `rate_limits` rows older than 2 minutes, `script_states`
orphans (script deleted but state surviving — should be zero), and
`compressed_ranges` with `startIdx >= endIdx` — and returns per-table
counts. `POST /api/admin/cleanup` runs it: open under `AUTH_MODE=none`,
otherwise instance admins only (401/403). No cron trigger ships;
self-hosters call the endpoint from their own scheduler (README). All
deletes use `RETURNING` + `db.all` so counts work on both drivers.

## Deployment

Two supported paths (README has the full steps):

- **Cloudflare (recommended)**: `wrangler d1 create`, paste the id
  into the `[env.production]` block of `wrangler.toml`,
  `wrangler secret put SESSION_SECRET --env production`,
  `pnpm deploy` (builds everything, then
  `wrangler deploy --env production`). Production sets
  `NODE_ENV=production` for the strict CSP.
- **Node self-host**: Node 24 + a writable SQLite path;
  `DB_DRIVER=local DB_PATH=... SESSION_SECRET=...`, `pnpm -r build`,
  then `node apps/api/dist/node.js` (`apps/api/src/node.ts`: same Hono
  app on better-sqlite3 via `@hono/node-server`, `PORT` default 8787,
  `RUN_MIGRATIONS_ON_BOOT=true` migrates on boot, SIGTERM/SIGINT
  drain connections and quit 0). `pnpm start` builds (`build:node`:
  `tsc -p tsconfig.node.json` + vendored WASM copy) and runs it.
  Serve `apps/web/dist` statically or `pnpm --filter web preview`.

Probes: `GET /api/health` → `{ ok, service, version }`;
`GET /api/health/ready` → 200 when `select 1` answers, else 503.
Neither needs auth; neither exposes the database path.

## Testing

Two layers, split by purpose:

- **Unit + integration (vitest, per package)** covers logic,
  validation, provider adapters, context assembly, and the
  generation pipeline — including SSE shapes, auth, import/export,
  and the scripts sandbox. Fast, runs in the main CI job.
- **E2E golden paths (Playwright, `e2e/`, Chromium only)** covers
  exactly the user flows in `e2e/tests/` (auth, wizard, stories,
  generation, settings, providers) — capped at 25 tests so the
  suite stays fast and non-flaky. Runs in its own CI job, after
  the main build.

The stub provider (`e2e/fixtures/stub-provider.ts`) implements the
OpenAI-compatible `/v1/chat/completions` streaming protocol with
four modes (`stream` / `empty` / `error` / `slow`, selected by the
`X-Stub-Mode` header or the server-side default) plus a stable
`/v1/models` listing. E2E never touches real LLM APIs.

Each spec file gets a fresh SQLite file (migrations applied on
boot), its own API (the real Node entry point, `AUTH_MODE=single`,
rate limiting off, scripts off) and the built web bundle served
statically with `/api` proxied — so files are hermetic and can
never leak stories, providers, or sessions into each other.
Application source is never modified to satisfy E2E: a failing
golden path is logged in PROGRESS.md as a bug, not patched around.

## Crypto

Provider keys are AES-GCM encrypted (`apps/api/src/crypto.ts`) with a
data key derived as HKDF-SHA256(`SESSION_SECRET`, info
`"opendungen-provider-keys"`, 32 bytes). Sessions derive from the same
secret, so **rotating `SESSION_SECRET` invalidates stored provider keys
and all sessions**. Keys are never logged; API error text never echoes
them.

## Frontend: design system (Phase 6)

Typography does the work — three roles, three variable fonts
(`@fontsource-variable/*`, imported once in `main.tsx`):

- **Serif** (`Source Serif 4 Variable`) — narrative text and AI
  output, 18px / 1.75 line-height (17px under 480px), measure capped
  at 680px (`.story-prose`).
- **Sans** (`Inter Variable`) — all UI chrome, 14–15px.
- **Mono** (`JetBrains Mono Variable`) — player input, action
  indices, code editors, quiet controls, 15px for input / 12px for
  controls.

Color tokens (`apps/web/src/index.css`, Tailwind v4 `@theme inline`):
`bg / surface / surface-hover / border / text / text-muted / accent /
danger`. **Dark is the default** (`:root` carries the warm near-black
palette; `html:not(.dark)` carries the paper light theme); the
pre-paint script in `index.html` defaults to dark. One accent color
only — warm amber (`#c98a3f` dark / `#a8621c` light); nothing else is
colored. No raw grey/blue/slate utilities anywhere; `border` is used
sparingly and only in `--color-border` with a reason (drawer/backdrop
separation, inputs).

## Frontend: story view (Phase 6, revised 6b)

This replaces the Phase 2a chat-bubble design: the story is a single
continuous scrolling column of `<div class="action">` with no
borders, backgrounds, or rounded corners — vertical rhythm is
`margin-bottom: 1.25rem` between actions. Player input and AI output
are the same kind of thing, differing only by position/marker:
player do/say lines sit at the margin (mono) with a quiet accent `›`
plus an uppercase mode tag (hover- or 2s-fresh-only); story-mode
inputs and all AI output are serif prose indented 1.5rem with no
marker at all.

- **Footer (6b order)**: the eye path is text → actions → input. A
  quiet mono row (Continue · Retry · Undo, 12px, `·` separated,
  right-aligned) sits ABOVE the textarea; below it, the mode
  switcher (left) and Send/Stop (right). Continue is primary-weight
  (`--color-text` instead of muted) and hidden under 480px; all
  three disable while streaming. Continue is a real generation
  (`POST /generate { continue: true }`, no input action) — the old
  fake-ellipsis input is gone. The footer is `position: sticky;
  bottom: 0` with safe-area padding, and the scroll column carries
  120px of bottom padding so the last action is never hidden.
- **Generation errors are inline (6b)**: a mid-stream or provider
  failure renders in the story column where the output would have
  been — 13px sans muted, no background, 1.5rem indent — as
  `Generation failed: <message>` with mono accent Retry · Edit input
  buttons. The input above stays rendered and editable. No toast for
  generation failures; toasts are for mutations only. Retry on a lone
  input regenerates for it; retry on an output deletes and
  regenerates (including outputs that followed a continue).

- **Mode switcher**: Do | Say | Story segmented control below the
  textarea, left-aligned (Send/Stop sits right, same row; default Do,
  persisted per user in
  `opendungen.inputMode`; Cmd/Ctrl+1/2/3). Placeholders change per
  mode. The client transforms text before sending (`do` → prefix
  `You ` unless you-/I-led; `say` → wrap in `"..."` unless quoted;
  `story` → passthrough); the server applies the same idempotent
  rule and stores the mode verbatim on `actions.mode` (NULL = AI
  output; omitted defaults to `story`). The optimistic overlay uses
  the transformed text so it matches the persisted row exactly.
- **Streaming** renders in place at the same position/style as a
  finished output — deltas append, a 1px accent caret blinks at the
  end, no typing indicator. Auto-scroll pins the bottom (instant
  assignment, never smooth) only while the reader is within 200px
  of it, hasn't scrolled away, and hasn't scrolled in the last
  800ms; otherwise a circular
  jump-to-latest button appears (clicking it resumes auto-scroll).
- **Header** collapses to zero height on scroll down, expands on
  scroll up/top; title edits in place (Enter commits, Esc cancels),
  provider badge + hover-only context readout, gear opens the
  drawer, hamburger opens nav.
- **Footer** (6b order — see above): quiet actions above the input,
  mode switcher + Send/Stop below. Context readout moved to the
  header (hover-only).
- **In-place editing**: clicking any action swaps it for a
  `contenteditable` div in the same typography/position, with a
  Save · Cancel mono bar (Enter commits, Esc cancels,
  Cmd/Ctrl+Enter commits, blur commits). Only the owner edits
  (single-user: everyone); disabled on the last output while
  streaming.
- **Settings drawer**: right slide-in (420px desktop, full mobile),
  collapsible sections — Narrative (layers editable, summary
  read-only + disabled regenerate marked Coming soon), Provider,
  Advanced (per-field reset), Scripts, Context ranges, Story
  (created/count/complete/delete). Opens via gear, Cmd/Ctrl+,,
  or a palette script entry; Esc/backdrop closes.
- **Command palette** (`command-palette.tsx`, no library): Cmd/Ctrl+K
  dialog with fuzzy-filtered actions (resume/list/new/scenarios/
  providers/settings/theme/sign-out/admin maintenance) + stories by
  title + current-story scripts; arrows/Enter/Esc. A power-user
  shortcut: primary navigation is the persistent top bar (6b).
- **Auto-resume**: `/` renders `views/home.tsx`, which shows the
  most recently updated story as a Continue card (title, scenario
  context, relative time + action count, last-output preview), or
  renders the one-scenario empty state when there are none (6b); `/stories` is the explicit list.
  Story views open scrolled to the bottom with the input focused.
  Login preserves the intended route via
  `opendungen.postLoginRedirect` (sessionStorage): deep links and
  401 bounces return there after login instead of `/`.
- **Story list**: plain rows (no cards) — sans title, mono relative
  time, hover-only action count, hover surface; search + text sort
  menu (updated/created/title) above centered tabs — Playing
  (has an output) / Completed (`completed_at` set via the drawer) /
  Drafts (zero actions); 20-row truncation with View-all.

## Frontend architecture (Phase 3)

The web app (`apps/web`) has a shell + views structure with no router
library: `src/location.tsx` parses the URL into a `View` union
(setup/login, wizard steps 1–3, stories, story, scenarios,
scenario-new, scenario-new-name, scenario, providers, settings),
`navigate()` does pushState + a popstate dispatch,
and views read the same context via `useLocation()`. react-router is
deliberately not used — six views don't justify the dependency, and
view state in context keeps auth-gating in one place (the boot gate in
`main.tsx`, whose routing matrix is a pure tested function).

Phase 6b restored a minimal persistent top bar: 40px, Home icon +
Stories + Scenarios + settings gear, active item in accent. `Shell`
provides the bar, the nav drawer (hamburger in view headers, user
menu/theme/sign-out/maintenance), the command palette, and the
location context; views own their content headers (the story view
keeps its own title/provider header below the bar). The wizard
renders outside the shell, so it never shows the bar. Every other app
view (story, stories, scenarios, scenario-new, scenario-new-name,
scenario, providers, settings, home) renders inside `Shell`.

Server state lives in @tanstack/react-query with the documented keys
(`auth-state`, `me`, `stories`, `story/:id`, `providers`, `scenarios`,
`scenario/:id`, `ranges/:storyId`, `scripts/:storyId`); mutations
invalidate the relevant key and toast failures without clearing form
state. SSE generation streams stay in local component state (optimistic
input overlay + deltas), never in the query cache. Client-only state
(current view, `navigate`, theme) lives in small contexts — no Redux /
Zustand / Jotai. A global 401 handler on the query/mutation caches
clears the auth-state entry and sends the user to /login.

Theme is light/dark/system persisted to `opendungen.theme`; the `.dark`
class flips semantic Tailwind v4 tokens (`bg, surface, border, text,
text-muted, primary, danger` defined via `@theme inline` over
`:root`/`.dark` variables, class strategy via `@custom-variant`),
applied pre-paint by an inline script in index.html. The wizard (3
steps: scenario → name → provider) runs for authenticated
zero-provider users who never finished
it; completion is a localStorage flag (`opendungen.wizard.v1`), not
server state. Story-view shortcuts (Enter send / Shift+Enter newline /
Esc abort / Cmd+Ctrl+Z undo / Cmd+Ctrl+R retry, the last two hijacked
only with an empty input in focus, plus Ctrl/Cmd+Up/Down input
history) live in a tested hook (`shortcuts.ts`) and a pure helper
(`input-history.ts`); toasts are a
hand-built stack, skeletons cover every list.

## Frontend: flows (Phase 6b)

Flow-level rules: the story is the interface (chrome recedes during
play); at highest intent show one option, not a grid; navigation is
always visible (top bar); controls sit above the input, not below;
resume opens at the exact bottom position with the input focused;
errors appear inline where the output would have been; every empty
state has one primary action and one secondary path.

- **First run (wizard)**: step 1 is a single-column scenario list
  (`scenario-list.tsx`, shared with /scenarios/new) with fantasy
  pre-selected — click/Enter advances; step 2 is one centered serif
  18px name field pre-filled from the scenario title; step 3 is the
  provider form with Connect (save + default), Test connection
  (green ✓ + model / red ✗ + real error, inline), and a Skip for now
  link. Connect or Skip creates the story and navigates straight to
  it — no "ready" step. After Connect, the story view fires a
  continue turn immediately (`opendungen.autostart` sessionStorage
  handoff, consumed on mount) so the opening streams on arrival.
  After Skip, a persistent "Connect a provider to start playing" +
  Set up banner shows until a provider exists.
- **Landing**: `/` renders `views/home.tsx`, a Home card for the
  most recently updated story (Continue / Start writing for drafts,
  last-action preview, All stories link) — never an auto-navigate;
  with zero stories it renders one centered 480px card for the fantasy
  scenario (serif title, muted description, full-width Begin,
  Browse all scenarios link). Begin creates from fantasy and
  navigates.
- **New story**: `/scenarios/new` (single-column list, first item
  pre-selected with a 2px accent left border, click/Enter advances
  via `opendungen.newStory.scenarioId`) → `/scenarios/new/name`
  (centered serif field, pre-filled, autofocus, Enter creates and
  navigates). `/scenarios` (browse) is unchanged.
- **Play loop**: Continue fires `{ continue: true }` (backend §12:
  no input action, input-hook skipped, output appended at max+1);
  Retry regenerates the last output (or the lone input's missing
  output); Undo deletes the last pair — or only the output after a
  continue. Ctrl+Up/Down cycles the last 50 inputs client-side,
  preserving in-progress text.
- **Lists**: `/stories` tabs (Playing/Completed/Drafts) with
  per-tab empty states; completion toggles via the drawer Story
  section (`PATCH { completedAt }`, migration 0006).

## Code comment conventions

- Comments explain WHY, not WHAT.
- Never reference build phases, specs, or prompts.
- Never narrate change history in comments — that is what git history
  and CHANGELOG are for.
- TODOs and FIXMEs live in docs/TECH_DEBT.md, not scattered in source.

## Frozen decisions — do NOT change without a PROGRESS.md entry

- Flat action log; no branching tree, ever.
- No default LLM provider/model; per-user keys encrypted (AES-GCM,
  instance secret) from Phase 2 on.
- `AUTH_MODE` semantics; session cookie name `opendungen_session`;
  scrypt params above; single mode means exactly one user.
- snake_case DB columns ↔ camelCase API JSON; timestamps are integer ms.
- One `./drizzle` migration history for D1-local, D1-remote, and tests.
- `packages/shared/src/story.ts` changes only via explicit decision.
- D1 in prod / better-sqlite3 locally; worker bundle never includes
  Node native modules (`db.ts` vs `db.local.ts` split).
- No tables, columns, or endpoints beyond the Phase 1 list without a
  new phase prompt.
