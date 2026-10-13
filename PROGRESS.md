# OpenDungen — Progress

## Release: v0.1.0

Ship prep completed in Phase S. Checklist (source: docs/RELEASE.md):

- [x] LICENSE present (Apache-2.0)
- [x] SECURITY.md present (vulnerability reporting, scope, supported versions)
- [x] CHANGELOG.md present with [0.1.0] section
- [x] README has License, Security, Changelog, Screenshots sections
- [~] docs/screenshot.png is a 1x1 placeholder; real screenshot needed before announcement
- [x] Version is `0.1.0` in root, apps/api, apps/web package.json
- [x] `GET /api/settings/instance` reads version from package.json (returns `"0.1.0"`)
- [ ] Git tag v0.1.0 (user action, not yet pushed)
- [ ] GitHub release published (user action)


## Done
- Phase 0: workspace scaffold, Hono worker, Vite app, Drizzle+libSQL
  dual driver, CI, docs stub.
- Phase 1: D1/libSQL schema (9 tables) + drizzle-kit migrations,
  3 seeded builtin scenarios, AUTH_MODE flag (none/single; multi 501),
  scrypt+jose session auth, stories/actions/cards CRUD API with zod
  validation, minimal web UI (setup/login/list/story views), vitest
  coverage (auth/stories/actions/cards/schema), ARCHITECTURE.md.
- Phase 2a: LLM provider abstraction (openai / anthropic / ollama /
  openai-compatible) with streaming + abort + typed errors,
  AES-GCM provider-key encryption (HKDF from SESSION_SECRET),
  provider config API (CRUD/test/set-default), AID-shaped context
  assembler with budget rules + audit, generation pipeline
  (input/output persistence semantics, no-op Phase 2b hooks),
  generate/retry/undo/edit endpoints over SSE, Providers screen +
  story-view generation UI (streaming bubble, Stop, context readout),
  vitest coverage (factory/crypto/assemble/pipeline/providers/
  generate), ARCHITECTURE.md crypto/SSE/assembly sections.
- Phase 2b: Scripts engine (QuickJS): scripts + script_states tables
  with one-owner CHECK, sandboxed input/context/output hooks with
  deterministic random + timeout/memory/state caps, script CRUD +
  validate API, generate/retry script_errors SSE event, Scripts
  panels in the story view (story + scenario), starter echo-filter
  example as docs.
- Phase 2c: DCP-style compression: post-turn trigger at 60% of the
  8192 budget, separate non-streamed compressor call (600 tokens,
  temp 0.2, strict-JSON decisions), nested compressed_ranges with
  parentRangeId + last-3/partial-overlap validation, range
  substitution in assembly (outermost-only, per-turn restoreRangeIds),
  ranges list/delete API, generate/retry restore bodies, meta
  rangesApplied, Context ranges UI (nested list, restore-this-turn +
  chip, delete with confirm, refetch after done).
- Phase 3: ESLint flat config (TS recommended + React + hooks,
  floating/misused promises + exhaustive-deps as errors, prettier as
  separate format script, CI runs both); backend scenarios list/detail
  + settings instance/account + logout-all endpoints; app shell
  (sidebar/drawer/topbar, no router) with URL-synced view context;
  react-query server state with global 401 → login; scenario picker +
  scenarios screens; 4-step first-run wizard (localStorage
  completion); light/dark/system theme with pre-paint class + token
  colors; mobile layouts + sticky story input; story keyboard
  shortcuts + cheat-sheet; toasts/skeletons/inline SSE errors;
  story list search/sort/cards/relative time; settings screen;
  happy-dom vitest coverage (shell/picker/wizard/shortcuts/theme/
  boot/endpoints).
- Phase 4: versioned JSON import/export (single-story + full, merge /
  confirmed replace, keys never exported or imported, ids regenerated
  with FK remap, summary + skipped reasons); scenario authoring
  (user-owned scenarios with create/edit/delete/duplicate, builtins
  read-only, stories unlinked on delete); per-story provider override
  (persistent providerId, ON DELETE SET NULL, one-off body override,
  retry resolves like generate); per-story context/compressor
  overrides (5 nullable fields, validated ranges, effective values in
  an Advanced panel); lazy QuickJS (dynamic wasm import on first
  script execution, cached); explicit-column `db.all(sql...)`
  projections on the actions hot paths (list + export); single 0003
  drizzle migration via `db:generate`; ARCHITECTURE import/export +
  per-story-settings + authoring sections.

- Phase 5: hardening + shippability. D1-backed rate limiting on the
  six expensive endpoints (60/min generate/retry, 20/min provider
  test, 10/min import/login, 5/min setup; 429 + Retry-After;
  RATE_LIMIT_ENABLED=false bypass); SSRF gate on provider baseUrls
  (scheme/credentials/literal-IP/DNS checks, fail closed, opt-in
  private flag); security headers (strict CSP in production, relaxed
  connect-src in dev) + Origin-check CSRF (setup/login exempt) + 1 MB
  bodies (64 MB import) + opt-in CORS; structured JSON logs with
  request ids (echoed header, error responses, per-request line);
  POST /api/admin/cleanup maintenance (expired sessions, stale
  limits, orphan states, inverted ranges; admin-only except none
  mode); [env.production] wrangler block + deploy scripts; health
  version + /ready probe; Node entry (node.ts + @hono/node-server +
  pnpm start) with boot migrations and clean SIGTERM; settings
  Instance section (limits/SSRF/log level + maintenance button);
  INSTANCE_SCRIPTS_ENABLED kill-switch; ARCHITECTURE Security /
  Observability / Deployment / Maintenance sections + README rewrite.

- Phase 6: full frontend redesign — typography/tokens (serif
  narrative, sans UI, mono input; dark-by-default warm palettes, one
  amber accent), continuous-column story view (no bubbles; player
  do/say lines marked by position + quiet › marker, story-mode
  indistinguishable from output), input mode switcher (do/say/story
  with client transform + `actions.mode` column via 0004 migration,
  idempotent server rule), in-place click-to-edit (contenteditable,
  Enter commits / Esc cancels / blur commits), collapsing header +
  sticky footer with quiet Undo · Retry · Continue · Settings,
  settings drawer (Narrative/Provider/Advanced/Scripts/Ranges/Story),
  command palette (⌘K, no library), `/` auto-resume + plain story
  list, mobile drawer/sticky-footer, 61 web vitest (17 files) +
  11 API mode tests passing, ARCHITECTURE design-system/story-view
  sections.

- Phase 6b: user-flow refinement (flows, not pixels). Persistent 40px
  top bar (Home/Stories/Scenarios/gear; wizard renders outside the
  shell); footer reordered (Continue · Retry · Undo above the input,
  mode + Send/Stop below; Continue is primary-weight); wizard
  reshortened to scenario → name → provider with dots, skip link,
  setup banner, and opening-turn autostart (`opendungen.autostart`);
  `/` zero-story one-scenario empty state (Begin + Browse);
  resume opens at the bottom with input focused; login preserves the
  target route (`opendungen.postLoginRedirect`); /stories tabs
  Playing/Completed/Drafts via nullable `stories.completed_at`
  (0006 migration, drawer Mark complete/playing); generation errors
  inline in the story column (Retry · Edit input, never toasts);
  Ctrl+Up/Down input history (last 50, client-side);
  /scenarios/new + /scenarios/new/name two-screen flow (shared
  `scenario-list.tsx`; ScenarioPicker deleted); Continue is a real
  generation (`POST /generate { continue: true }`: no input action,
  input-hook skipped, `newInput` omitted from assembly, meta
  `inputActionId: null`; retry-after-continue regenerates the same
  way). ARCHITECTURE "Frontend: flows" + backend continue sections.
- Phase R: code organization refactor (pure, no behavior change).
  Split app.ts (3526) into a composition root + routes/ (one file
  per route group) + services/ (auth/stories/providers/generation/
  import); web api.ts (799) into api/ (one module per resource);
  views/story.tsx (1792) into views/story/ (panels, drawer, footer,
  header, useStoryTurn, useStoryScroll); views/providers.tsx and
  views/scenarios.tsx into matching directories; scripts/runner.ts
  into types/sandbox/runner; pipeline.ts turn phases into named
  helpers + generation/persist.ts. Added docs/STRUCTURE.md.
  Test counts unchanged (api 306, web 101, shared 2).
- Phase 6c: pre-v1 bug fixes (`/` Home Continue card instead of
  auto-resume; provider label required with kind-based suggestions +
  Rename affordance; provider badge deduped via providerDisplayName;
  top fade only when scrollTop > 0; streaming auto-scroll with
  200px threshold + 800ms quiet window + scrolled-away flag;
  /stories newest-row emphasis). Test counts: api 307, web 119,
  shared 2.
- Phase P: narrative prompt engineering. Layered prompt
  (`context/prompts.ts`, fixed wording): base system prompt +
  output constraints (120–180 words, agency, anti-summary, hook) +
  per-scenario instructions (append-only contract) + per-turn mode
  directive (do/say/story/continue) + plot essentials + summary +
  keyword cards + verbatim history + Author's Note (`memory` field,
  square-bracketed, after history) + mode-formatted input (`> ` for
  do/say, none for continue). `supportsMultipleSystemMessages`
  provider flag (false for ollama/openai-compatible → joined single
  system); cache prefix runs through the last stable system;
  trimming is cards → memory → summary (floor 100t) → plot, never
  the fixed layers or the last action. Seeded scenarios carry tone
  instructions; settings drawer shows "Author's Note" + helper;
  scenario editor documents the append contract. Eval harness
  (`scripts/eval-prompt.ts` + 10 cases, human-read output, no CI).
  Test counts: api 319, web 119, shared 2.
- Phase F: P0/P1 debt fixes. Empty completion: the pipeline retries
  a zero-output stream exactly once via the existing withRetry path;
  two empties surface SSE `error { code: empty_completion }`
  ("The model returned no output. Try again.") with the input
  persisted and no output row (new ProviderErrorCode member + 5
  pipeline tests + 1 SSE test). drizzle-orm 0.38.4 → 0.45.4
  (GHSA-gpj5-g38j-94v9 patched; typecheck + suite green, no callsite
  changes); better-sqlite3 deliberately held at 11.10.0. Ollama
  Cloud audit: Bearer is sent on /api/chat, /api/tags, and the
  completion fallback (verified by 4 mock-fetch tests) — the 401
  divergence is provider-side, still open pending a valid key.
  Scenario openings seed new stories: POST /api/stories persists
  `opening` as the first output action (idx 0); wizard/new-story
  autostart removed (autostart.ts deleted) — the view shows the
  opening with the input focused, no auto-generation. "Coming soon"
  removed from the drawer (summary stays read-only). QuickJS: no
  Cloudflare credentials in this environment (Path B) —
  INSTANCE_SCRIPTS_ENABLED=false documented in README
  troubleshooting; production verification still open.
  Test counts: api 330, web 120, shared 2.
- Phase E: end-to-end browser testing (Playwright, Chromium only).
  21 golden-path tests in `e2e/tests/` (auth 3, wizard 3, stories 4,
  generation 5, settings 3, providers 3) against per-file servers:
  stub LLM (OpenAI-compatible streaming, stream/empty/error/slow
  modes), real API from source via tsx (temp SQLite, migrations on
  boot, single mode, no rate limits, no scripts), built web bundle
  served statically with an `/api` proxy. Separate `e2e` CI job
  (needs the main job; installs chromium with deps). Full suite:
  21 passed in ~20s. Notable findings while writing the suite (test
  code issues, not app bugs): the story-view menu button is
  mobile-only so sign-out goes through Settings; the drawer Story
  section starts collapsed; API-created setup sessions share the
  page context, so E2E setup uses an isolated request context.
  Test counts: api 330, web 120, shared 2, e2e 21.
- Nothing required for v1. Optional Phase 7: story sharing/
  publishing, multiplayer, i18n.
- Phase R borderline files (kept, with reasons — see Phase R
  report): web views/settings.tsx (345, one component) and
  views/wizard.tsx (316, one flow); api context/assemble.ts (336),
  llm/ollama-provider.ts (341), llm/openai-compatible-provider.ts
  (335), llm/ssrf.ts (289), context/compress.ts (275) (each one
  cohesive concern); services/generation.ts (364),
  services/import.ts (337), routes/import.ts (341),
  views/story/DrawerPanels.tsx (333),
  views/providers/ProviderFields.tsx (329) (flat sections, single
  concern each); generation/pipeline.ts generateTurn (~185, one
  abort/timeout lifecycle that must stay in a single try/finally
  scope); all *.test.ts suites (cohesive per-concern, splitting
  adds churn with zero benefit).

## Known issues
- docs/screenshot.png is a placeholder; replace before public announcement.
- Phase P eval (gpt-oss:20b via Ollama Cloud, temp 0.8, 2026-10-13):
  length compliance is partial — first pass word counts:
  fantasy 100, scifi 55, dialogue 206, failure 188, continue 123,
  agency 151, length 159 (4/10 inside 120–180). Mystery/long-context
  returned empty once each, then 26/157 words on retry; tone_drift
  ("laugh at the corpse") and one continue turn returned empty
  twice running, while the identical continue context sent directly
  returns prose — intermittent empty completions are provider-side
  (streaming NDJSON verified healthy), not assembly. Phase F now
  retries one empty completion per turn and surfaces
  `empty_completion` after two; length retuning remains a later
  iteration per the phase rules. Observed quality wins: dialogue answers in character
  ("Name's Mara…") with a minor agency leak ("Your voice answers
  before you're finished"); failure is honest (a fall, injury, a
  decision point); say-turn output ends on a hook. Old-vs-new
  (opening_fantasy, same model): OLD bare prompt (empty system +
  "look around") → 153-word markdown bullet travel-guide ending
  "What would you like to do?"; NEW layered prompt → 168 words,
  second person present, iron/smoke/clang/chill/crunch sensory
  detail, no recap, ending on an unanswered fragrance. Full outputs
  in apps/api/scripts/eval-output/2026-10-13T16-10-40-004Z/.
- QuickJS WASM on real Cloudflare still UNVERIFIED (from
  Phase 5). This phase does not change it. The
  bundle-time newVariant(RELEASE_SYNC, { wasmModule }) pattern is
  proven under workerd locally but production verification requires
  a real deploy. If it fails, the fallback is to gate Scripts behind
  an INSTANCE_SCRIPTS_ENABLED env flag defaulting to false, so a
  deploy without working Scripts still functions.
- Phase 6b (fixed in Phase F): scenario `opening` is now persisted
  as the new story's first output action (idx 0); wizard autostart
  removed. `aiInstructions` still never seed story layers — future
  work, not this phase.
- Phase 6b: the story view intentionally shows two header rows (the
  40px top bar + the 48px story header). Accepted per spec.
- Phase 6b (fixed in Phase F): wizard autostart removed entirely
  (autostart.ts deleted) — the StrictMode double-mount quirk is gone
  with it.
- Phase 6c (still open after Phase F audit): on the dev instance,
  the stored Ollama Cloud key passes POST /api/providers/:id/test
  but POST /generate fails with 401 from Ollama. Code-side audit
  finds no divergence — Bearer is sent on /api/chat, /api/tags, and
  the completion fallback alike (locked by mock-fetch regression
  tests), so the cause is provider-side (key scope?) and needs a
  valid key to investigate; streaming was verified with a fake local
  Ollama instead.

## Decisions
- Phase E: E2E is Playwright, Chromium only, capped at 25 tests.
- Phase E: E2E uses a stub provider, never real APIs.
- Phase E: fresh SQLite per test file (temp dir, removed after).
- Phase E: E2E runs in a separate CI job from the main build (needs
  it; the main job stays under 5 minutes).
- Phase F: a scenario's `opening` is its new story's first output
  action (idx 0, type output); stories without a scenario start with
  an empty log. Creation never triggers a generation.
- Phase F: an empty/whitespace-only completion retries exactly once
  per turn; two empties persist no output and surface
  `empty_completion`. The input action is always kept.
- Phase F: drizzle-orm tracks the patched line (>=0.45.2 for
  GHSA-gpj5-g38j-94v9); better-sqlite3 stays on v11 (v13 has no
  prebuilt binary and this environment cannot compile it).
- Stack: Vite+React / Hono on Workers / libSQL+Drizzle (dual driver:
  D1 in prod, better-sqlite3 locally) / Tailwind v4 / pnpm / Node 22.
- No default LLM provider or model. Self-hoster configures via setup
  screen in Phase 2.
- Per-user API keys, encrypted (AES-GCM, key from instance secret).
- Single-user v1; auth mode flag for multi-user later.
- Story model: flat append-only action log + DCP-style compressed
  ranges (nested). Retry/Undo/Edit mutate the log; no branching tree.
- Context budget defaults: 8192 tokens, required cap 70%, history 50%
  of dynamic, cards 25%, memory 25%, compress trigger at 60%.
- Prompt caching to be built into provider interface in Phase 2.
- Scripts engine IS in scope (input/context/output hooks); designed
  in Phase 2, not v1-blocking.
- Compression is LLM-driven, nested, and reversible (restore button);
  full action log always retained in DB.
- Phase 1 auth: session cookie name `opendungen_session` (httpOnly,
  SameSite=Lax, Secure only over HTTPS so local HTTP dev works);
  JWT via jose (HS256, 30-day expiry, session id in `sid` claim,
  backed by a DB row so logout revokes); passwords via
  @noble/hashes scrypt (N=16384, r=8, p=1, 32-byte hash) because
  argon2 cannot run on Workers; secret is SESSION_SECRET (wrangler
  secret in prod, `.dev.vars` locally, never committed).
- Phase 1 migrations: one `./drizzle` history for D1-local
  (`--local`), D1-remote (`--remote`), and tests (better-sqlite3
  migrator); wrangler reuses it via `migrations_dir = "drizzle"`.
- Phase 1 API: snake_case DB columns map to camelCase JSON; all
  errors are `{ error: { code, message } }`; soft-deleted stories
  read as 404; action `idx` is server-assigned (max+1 with retry on
  unique conflict); setup auto-logs-in the new admin.
- New deps (all on the allowed list): @noble/hashes, jose,
  @hono/zod-validator, zod. (Plus @tailwindcss/vite and @types/react*
  carried over from Phase 0; lint is prettier --check, not ESLint.)
- Phase 2a deps (allowed list): openai, @anthropic-ai/sdk. Ollama and
  openai-compatible use plain fetch, no SDK. @opendungen/shared is now
  a real api dependency (budget constants); api predev/pretypecheck/
  pretest/prebuild rebuild shared dist so fresh checkouts work.
- Rough token estimate = chars/4 × provider.tokenMultiplier
  (no tokenizer shipped).
- Session and provider-key encryption both derive from
  SESSION_SECRET; rotation invalidates both.
- Retry deletes the old output before regenerating (no history
  of retried attempts).
- Phase 2b scripts: sandbox surface is state/text/context/log/
  history only; 200ms timeout; 2 MB runtime memory; 64 KB state
  cap per script per story; script errors are non-fatal and
  per-script (failing script skipped, turn continues); output hook
  affects persisted text only (streamed deltas are already sent).
  Scripts run at every hook and guard on defined globals; scenario
  scripts run before story scripts, position order within each.
- Phase 2b deps (allowed list): quickjs-emscripten. The .wasm binary
  is vendored (src/scripts/emscripten-module.wasm) and loaded via
  the documented newVariant(RELEASE_SYNC, { wasmModule }) pattern so
  no runtime fetch/compile happens in the worker isolate; vitest
  compiles the same bytes through a config alias.
- Wrangler 3.114 → 4.149 (devDep bump for a current local workerd).
- Compression is a separate non-streamed call; never a tool call
  in the narrative stream.
- Trigger = estimatedTokens >= 60% of totalTokens.
- Compression failure never blocks a turn.
- Restore is per-turn and client-supplied; never persisted.
- Nested ranges: only the outermost produces a message.
- Partial overlaps between new and existing ranges are rejected.
- DELETE /api/ranges/:rangeId unlinks (not deletes) children so the
  delete works on drivers enforcing the self-referencing FK.
- No react-router; view state in context + pushState/popstate.
- react-query for server state; SSE stays in local component state.
- Theme persisted to localStorage; applied pre-paint.
- Wizard completion tracked in localStorage (not server).
- Semantic Tailwind color tokens instead of raw colors.
- Hono middleware/route contexts stay `any` (single-line disables):
  concrete Context types widen every downstream c.req.param to
  string | undefined (verified).
- Settings counts read full rows, not projections: the
  WorkerDb/LocalDb union breaks select-with-args overloads.
- Export format versioned; ids regenerated on import.
- Provider keys never exported (even with flag) and never imported.
- Scenario authoring limited to user-owned; built-ins are read-only.
- Per-story provider override persists; per-action provider is not
  stored.
- Compressor + context params per-story, all nullable with
  constant fallbacks.
- QuickJS loads lazily.
- `actions` queries use explicit column projections; other tables
  still select full rows.
- Phase 5: rate limiting only on expensive endpoints (D1-backed
  sliding windows, no cron); SSRF check before any provider fetch
  with an ALLOW_PRIVATE_PROVIDER_URLS opt-in for local Ollama; CSRF
  via Origin check on mutating requests (setup/login exempt); no
  Sentry unless SENTRY_DSN is set at deploy time (reserved hook only
  — the v11 Cloudflare root exports no usable runtime init, so no
  SDK ships); Node entry point for non-Cloudflare self-hosting via
  @hono/node-server; INSTANCE_SCRIPTS_ENABLED flag gates Scripts for
  safety; shared/story.ts is the constants contract while type
  interfaces are reference-only (API and web use local shapes).
- Phase 6: story view is a continuous text column, not chat.
- Phase 6 typography: serif narrative, sans UI, mono input.
- Phase 6: dark by default, one accent (amber).
- Phase 6 input mode (do/say/story) stored on actions as `mode`;
  transformation is client-side before persist (server reapplies the
  same idempotent rule).
- Phase 6: command palette replaces most navigation.
- Phase R: files over 400 lines must be split; functions over 80
  lines extracted; components over 250 lines decomposed.
- Phase R: one file per route group; one file per screen; no barrel
  files; no utils.ts catch-all; imports one-directional
  (routes → services → db).
- Phase 6: `/` auto-resumes the newest story.
- Phase 6c: `/` renders a Home card with Continue, not an auto-navigate.
- Phase P: base prompt is Latitude's Harbinger-24B system prompt
  (research-backed, two sentences).
- Phase P: output constraints include a hard word-count target
  (120–180 words).
- Phase P: player agency is enforced via an explicit rule.
- Phase P: anti-summarization is explicit.
- Phase P: Author's Note is placed after history, wrapped in square
  brackets.
- Phase P: scenario instructions append, never replace.
- Phase P: prompt changes are evaluated via the eval script before
  merging.
- Phase P: multi-system-message support is provider-configurable.
- Phase 6c: provider label is required; never defaults to model.
- Phase 6c: top fade only appears when scrollTop > 0.
- Phase 6c: auto-scroll disabled while the user has scrolled away.
- Phase 6: story settings live in a drawer, not the header.
- Ollama cloud vs local is derived from baseUrl; no separate
  provider kind.
- localhost:11434 and 127.0.0.1:11434 bypass SSRF for ollama
  without the flag.
- Ollama Cloud requires an API key on create; local does not.
- Phase 7b: Ollama Cloud support (cloud-vs-local derived from
  baseUrl, Bearer auth on cloud only, localhost-default SSRF
  exception, Local/Cloud radio in the provider form).
- Phase 6b: user-flow refinement over the settled Phase 6 visuals.
  - Persistent top bar restored (Home / Stories / Scenarios /
    Settings); Cmd+K stays for power users.
  - Footer layout: actions above input; mode switcher below
    textarea, left-aligned.
  - Setup wizard reordered: scenario → name → provider.
  - Provider step is skippable with a persistent banner.
  - Empty state shows one scenario, not a grid.
  - Story list has tabs: Playing / Completed / Drafts.
  - Generation errors are inline in the story column, not toasts.
  - Ctrl+Up/Down cycles the last 50 inputs.
  - Continue is a real generation call, not a fake "…" input.
