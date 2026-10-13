# OpenDungen — Code Structure

## Backend (apps/api/src/)
- `app.ts` — composition root: env/types, shared closures, register calls.
- `routes/` — one file per route group (`registerX(app, ctx)`):
  `auth`, `stories`, `actions` (+undo/edit), `cards`, `providers`,
  `provider-ops` (models/test/default), `generate` (generate/retry),
  `scenarios`, `export`, `import`, `scripts`, `ranges`, `settings`,
  `health`, `middleware`, plus `http` (apiError), `mappers` (row→JSON),
  `schemas` (shared zod), `types` (RouteCtx).
- `services/` — shared data access: `auth` (sessions), `stories`
  (live lookup), `providers` (resolution/SSRF/cache), `generation`
  (turn runner), `import` (backup validation).
- `llm/` — one adapter per provider kind + `ssrf`, `retry`, `listing`.
- `generation/` — `pipeline` (turn generator), `persist` (action
  writes), `hooks` (script wiring).
- `scripts/` — `runner` (hook loop), `sandbox` (QuickJS), `types`.
- `context/` — `assemble` (budget), `compress` (DCP ranges).
- `db/` — schema; `db.ts`/`db.local.ts` — D1/local drivers.

## Frontend (apps/web/src/)
- `api/` — one module per resource: `client`, `auth`, `stories`,
  `generation`, `providers`, `scripts`, `ranges`, `scenarios`,
  `settings`, `import-export`.
- `views/<screen>.tsx` — one file per screen; `views/story/` and
  `views/scenarios/` + `views/providers/` hold split screens
  (panels, drawer, footer/header, `useStoryTurn`, `useStoryScroll`).
- `queries.ts` — react-query keys/mutations; `location.tsx` — views;
  `shell.tsx`, `command-palette.tsx`, `ui.tsx`, `theme.tsx`,
  `toast.tsx`, `shortcuts.ts`, `input-mode.ts`, `input-history.ts`.

## Rules
- Files over 400 lines must be split.
- Functions over 80 lines must be extracted.
- Components over 250 lines must be decomposed.
- One file per route group; one file per screen.
- No barrel files. No utils.ts catch-all.
- Imports one-directional: routes → services → db.
- New code follows the layout above; if a new concern doesn't fit,
  propose a new directory and update this document.
