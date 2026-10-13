# Technical Debt

Discovered: 2026-10-13. Audit phase D.

Priority tiers: P0 (blocks v1) · P1 (fix before v1.1) · P2 (schedule) · P3 (nice-to-have).

## Summary

21 items: 2 P0, 3 P1, 7 P2, 9 P3.

Phase F (2026-10-13) resolved 4: drizzle CVE bumped, scenario
seeding fixed, "Coming soon" removed, and the empty-completion P3
fixed with a retry. QuickJS took Path B (flag documented, production
verification still open) and the Ollama 401 was audited but persists
provider-side (see items). The codebase is in better shape than a
multi-phase AI build has any right to be: zero empty catch blocks, zero
unjustified type escapes, one consistent error shape, one auth middleware
used everywhere, matching SSE event names on both sides, and clean
`tsc --noUnusedLocals --noUnusedParameters` on the API. The biggest themes
are (1) two ship-blockers — a high CVE in drizzle-orm and unverified
QuickJS WASM on real Cloudflare; (2) PROGRESS.md carryover that is already
well-documented but still unfixed (Ollama Cloud 401 divergence, scenario
openings never seeding stories, a visible "Coming soon"); and (3) mild
threshold drift — one generator function over the 150-line rule and
dead parameters in a pure routing helper. No confirmed 3+ logic
duplication was found; every candidate checked turned out to be idiom,
coincidence, or documented by-design mirroring.

## P0 — Blocks v1

- [x] **drizzle-orm high CVE (SQL injection via identifiers)** — `apps/api/package.json:30` (fixed Phase F: 0.45.4)
      What: We pin `drizzle-orm@0.38.4`, below the patched `>=0.45.2` for GHSA-gpj5-g38j-94v9.
      Why it matters: A high-severity SQL injection in the only production DB layer.
      Fix: Bump drizzle-orm (and drizzle-kit in lockstep) past 0.45.2 and re-run migrations/tests.

- [ ] **QuickJS WASM unverified on real Cloudflare** — `apps/api/src/scripts/qjs-module.ts:1` (Phase F: Path B — no credentials in env; flag documented in README; production verification still open)
      What: The `newVariant(RELEASE_SYNC, { wasmModule })` pattern is proven under local workerd only, never on a real deploy.
      Why it matters: If the WASM fails to load in production, every script hook breaks at runtime.
      Fix: Verify on a real deploy before v1, else ship with `INSTANCE_SCRIPTS_ENABLED=false`.

## P1 — Fix before v1.1

- [ ] **Ollama Cloud: test passes but generate fails 401** — `apps/api/src/llm/ollama-provider.ts:43` (Phase F: audited — Bearer confirmed on all paths + 4 regression tests; divergence is provider-side, still needs a valid key)
      What: A stored Ollama Cloud key passes `POST /api/providers/:id/test` yet `POST /generate` gets 401 from Ollama (found in Phase 6c, not fixed).
      Why it matters: Users who configure the documented cloud path cannot play; test success actively misleads them.
      Fix: Reproduce with a valid key and align chat/test auth paths (Bearer header is attached at line 47).

- [x] **Scenario opening/aiInstructions never seed a new story** — `apps/api/src/routes/stories.ts:29` (+1 more) (fixed Phase F: opening persisted as idx-0 output; autostart removed; aiInstructions seeding remains future work)
      What: Story creation ignores the scenario's `opening`/`aiInstructions`, so the wizard autostart continue generates the first turn from an empty system prompt.
      Why it matters: Every new story opens with free-association prose until the user writes; first-run quality is the product.
      Fix: Seed the new story's layers (or an opening action) from the scenario at create time.

- [x] **Visible "Coming soon" in the shipped settings drawer** — `apps/web/src/views/story/DrawerPanels.tsx:292` (fixed Phase F: row removed; no other "Coming soon" in shipped UI; Settings Export/Import buttons verified functional)
      What: The Narrative section renders a disabled "Regenerate summary" button plus a literal "Coming soon" label.
      Why it matters: Placeholder UI in a v1 drawer reads as unfinished; policy is implement-or-remove.
      Fix: Implement summary regeneration or remove the row entirely.

## P2 — Schedule

- [ ] **Dead parameters in bootTargetFor** — `apps/web/src/boot.ts:50` (+1 more)
      What: `providerCount` and `wizardDone` are accepted but never read (TS6133 under `noUnusedParameters`).
      Why it matters: Dead params in a pure, tested routing function mislead the next reader about what drives routing.
      Fix: Delete the params (and update callers/tests) or use them.

- [ ] **generateTurn exceeds the 150-line function rule** — `apps/api/src/generation/pipeline.ts:161`
      What: The turn generator spans ~220 lines (to line 381); Phase R consciously kept it whole so the abort/timeout lifecycle stays in one try/finally.
      Why it matters: The longest, most critical function is also the hardest to review; the keep reason is documented but the size is real.
      Fix: Extract only timeout/abort setup into helpers that preserve the single try/finally scope, or formally accept the exception here.

- [ ] **Module-global stream-options cache silently drops usage** — `apps/api/src/llm/openai-compatible-provider.ts:24`
      What: `noStreamOptionsEndpoints` is process-wide mutable state; once an endpoint 400s on `stream_options`, all later calls skip the flag and report `usage: undefined` forever.
      Why it matters: Token-usage audit silently degrades per endpoint with no log, metric, or expiry.
      Fix: Scope the flag per provider row (or TTL it) and log when usage is unavailable.

- [ ] **React-query keys drifted from ARCHITECTURE.md** — `apps/web/src/queries.ts:83` (+N more)
      What: Docs list keys like `story/:id` and `scripts/:storyId`; code uses `["story", id]`, plus undocumented `["actions", …]`, `["scenario-scripts", …]`, `["instance-settings"]`, `["account-settings"]`.
      Why it matters: Stale key docs cause wrong invalidations when the next developer adds a mutation.
      Fix: Update the ARCHITECTURE.md key list to match `queries.ts`.

- [ ] **Zod schemas split between shared file and route files** — `apps/api/src/routes/actions.ts:18` (+3 more)
      What: `editActionSchema`, `retryBodySchema` (generate.ts:31), `scenarioFieldsSchema` (scenarios.ts:38), and script schemas (scripts.ts:18) are defined inline while the rest live in `routes/schemas.ts`.
      Why it matters: Two homes for validation schemas; reviewers miss constraints during security review.
      Fix: Move the four inline schemas into `routes/schemas.ts`.

- [ ] **DELETE success shapes are inconsistent** — `apps/api/src/routes/stories.ts:158`
      What: Deleting a story returns `{ story }` (the soft-deleted row); cards/providers/scripts return `{ ok: true }`; undo returns `{ deleted: N }`.
      Why it matters: Clients must special-case per-resource deletes; a future 204 migration gets harder each month.
      Fix: Standardize on `{ ok: true }` (document the one exception if undo's count is load-bearing).

- [ ] **Prompt length compliance is partial (4/10 in range)** — `apps/api/scripts/eval-prompt.ts:1`
      What: Phase P eval word counts (fantasy 100, scifi 55, dialogue 206, failure 188, continue 123, agency 151, length 159) miss the 120–180 target more often than not.
      Why it matters: The hard word-count target is a core prompt requirement; current compliance is below half.
      Fix: Run another eval round and retune per the Phase P rules (never retune without an evaluation round).

## P3 — Nice-to-have

- [ ] **Phase/history comment noise (63 hits)** — `apps/api/src/db/schema.ts:14` (+62 more)
      What: 33 hits in apps/api + 30 in apps/web matching `Phase N` / `§N` / `previously` / `I chose`, e.g. `// Phase 2b: user scripts…`, `// Persistent top bar (Phase 6b)…`, `// previously suggested label…`.
      Why it matters: Archaeology comments rot; three examples suffice to show the pattern, the rest is grep-able history.
      Fix: Leave as-is or strip to one-line what/why during unrelated edits (no dedicated pass).

- [ ] **Script runner defaults to raw console.debug** — `apps/api/src/scripts/runner.ts:32`
      What: The default log sink is `(message) => console.debug(message)` instead of the structured `log.ts`.
      Why it matters: Unstructured lines bypass request-id/level gating in production logs.
      Fix: Default the sink to the structured logger.

- [ ] **Type escapes, all justified (6 hits)** — `apps/api/src/app.ts:132` (+5 more)
      What: `c: any` in requireAuth/currentUser/streamTurn plus the RouteHandler type, each with an eslint-disable and an explanatory comment (verified Hono inference widening); one grep hit is prose ("any code path"), not code.
      Why it matters: It doesn't — documented decision, but it should be re-checked on each Hono major bump.
      Fix: Revisit when upgrading Hono; keep the disables until then.

- [ ] **Best-effort catch swallows (3, all harmless)** — `apps/web/src/api/client.ts:25` (+2 more)
      What: `data = null` on non-JSON bodies, `text = ""` on failed error-body reads (openai-compatible-provider.ts), "Nothing to clear" on sessionStorage (boot.ts) — zero empty `catch {}` blocks repo-wide.
      Why it matters: It doesn't today, but silent fallbacks deserve a debug line if they ever mask a bug.
      Fix: Add debug-level logging to the three sites if diagnostics ever need it.

- [ ] **StrictMode dev-only autostart quirk** — `apps/web/src/autostart.ts:1`
      What: React StrictMode double-mount consumes the one-shot `opendungen.autostart` flag, so opening-turn autostart visibly fires only in production builds.
      Why it matters: Dev-only confusion; every developer re-discovers it.
      Fix: Guard the flag consumption with a ref so the second mount reuses it.

- [x] **Provider-side intermittent empty completions** — `apps/api/src/generation/pipeline.ts:150` (fixed Phase F: one retry per turn, then `empty_completion` with input kept and no output row)
      What: Mystery/long-context/continue turns occasionally return empty completions that succeed on retry; streaming NDJSON verified healthy, so it is provider-side, not assembly.
      Why it matters: Users see a failed turn for no local reason; currently indistinguishable from a real failure.
      Fix: Add a single automatic retry on empty (non-abort) completions and monitor frequency.

- [ ] **Web api/ modules lack direct unit tests** — `apps/web/src/api/client.ts:1` (+8 more)
      What: Nine hand-written fetch modules (stories/generation/providers/scripts/ranges/scenarios/settings/import-export) have no adjacent tests; view tests cover them indirectly.
      Why it matters: Error-mapping branches (`request_failed` fallbacks, ApiError codes) are untested at the unit level.
      Fix: Add thin vitest suites for `request()` error paths.

- [ ] **Infra files without direct tests** — `apps/api/src/log.ts:1` (+2 more)
      What: `log.ts`, `db.ts`, `index.ts` have no dedicated suites (exercised indirectly; `node.ts` and `qjs-module.ts` do have theirs); per-concern coverage is otherwise broad (40+ API suites).
      Why it matters: Request-id injection and log redaction are security-adjacent and only covered transitively.
      Fix: Add a small `log.test.ts` asserting requestId injection and body redaction.

- [ ] **Dev-only deps are majors behind** — `apps/web/package.json:1` (+N more)
      What: typescript 5.9→7.0, vite 6→8, vitest 3→5 latest (pinned majors still supported; `npm outdated` unavailable for some workspaces offline).
      Why it matters: Falling further behind raises the eventual migration cost; none affect shipped code.
      Fix: Bump one major at a time in a dedicated chore phase with full test runs.

## Rejected

- Commented-out code grep (6 hits): all false positives — prose comments starting with "for…", "return…", "so…", none is executable code. Not debt.
- TODO/FIXME/HACK/XXX sweep: zero hits; the only 2 matches are explanatory `NOTE:` comments in `scripts/sandbox.ts:98,127`. Not debt.
- `console.log` in `apps/api/scripts/eval-prompt.ts` and `console.debug` in `log.ts`/`runner.ts`: eval harness output and the production log sink respectively — legitimate uses. Not debt (P3 covers only the default-sinkrouting nit).
- Tailwind class-string repetition (`"flex flex-col gap-1 text-sm"` ×26): utility-CSS idiom, not logic duplication. Not debt.
- Repeated URL literals (`localhost:11434` etc.): test fixtures plus three legitimate non-test uses (SSRF allowlist, dev proxy, input placeholder). Coincidence. Not debt.
- Same local names across files (`const res/body/user/rows`): generic locals, not shared logic. Coincidence. Not debt.
- "Builds a live provider" comment in two files: single implementation (`services/providers.ts:liveProvider`); the routes copy is a stale-adjacent comment only. Not logic debt.
- Client/server input-mode transform mirror: deliberate idempotent design, documented in Decisions. Not debt.
- Compression failures swallowed (`maybeCompressAfterTurn`): documented contract — compression never blocks a turn, failures are logged. Not debt.
- `AUTH_MODE=multi` 501s (`routes/middleware.ts:294`): intentional reserved-mode behavior, tested. Not debt.
- Hono `any` contexts and full-row settings selects: explicit documented decisions with verified reasons. Not debt.
- Two header rows on the story view: accepted per spec (PROGRESS ## Known issues). Not debt.
- Single-use dependencies (quickjs-emscripten, jose, @noble/hashes, fontsource, react-query): each is core to a feature, none replaceable in 20 lines. Not debt.
- Old-vs-new prompt comparison in the eval notes: informational, not debt.
- Disabled-button sweep: all hits are busy-state guards (`disabled={isPending/busy}`) or input placeholders — no unexplained dead controls beyond the P1 "Coming soon". Not debt.
- Empty-catch / `.catch(()=>{})` / floating-promise sweeps: zero hits; `void`-marked invalidations and error-level floating-promise lint confirm hygiene. Not debt.
- Route error shape, auth middleware, SSE event names, body validation: verified consistent repo-wide (all errors via `apiError`, all routes behind `requireAuth`, client parses all five SSE events). Not debt.
- Phase R borderline files in PROGRESS ## Next: all non-test files are now ≤381 lines (under the 400 rule); the keeps were conscious acceptances, not unchecked carryover — except `generateTurn`, which is listed as P2 above.
