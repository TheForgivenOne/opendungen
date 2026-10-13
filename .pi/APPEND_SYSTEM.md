# OpenDungen — always-on rules

## Stack (locked)
TypeScript only. No Python. Hono on Cloudflare Workers. Vite +
React + Tailwind v4. libSQL + Drizzle (D1 in prod, better-sqlite3
locally). pnpm workspaces. Node 22.

No Next.js. No Postgres. No Redis. No component library. No router
library.

## Frozen files
- packages/shared/src/story.ts — never modify.
- apps/api/src/context/prompts.ts — prompt string constants are
  verbatim by design. Comments around them may be cleaned.
- apps/api/drizzle/*.sql — never edit an applied migration.

## Verification gate
Before claiming any task is done:
  pnpm -r typecheck && pnpm -r lint && pnpm -r format &&
  pnpm -r test && pnpm -r build
Show the output. Never claim success without evidence.

## Workflow gate
For any task touching multiple files, adding a feature,
refactoring, or deleting:
  1. Restate the task in 2-4 lines.
  2. Write a plan with steps and verification.
  3. STOP and wait for approval.
  4. Execute.
  5. Report: what changed, what you verified, any deviations.

Do NOT skip step 3.

## Git workflow
- Every phase runs on its own branch: phase-<letter>-<slug>.
- Never work on main. Never force-push.
- Commit at logical breakpoints with conventional commit messages
  (feat/fix/refactor/docs/test/chore/perf/build/ci).
- Do not push during or after a phase. Report the branch and
  commits. The user pushes and merges.
- Never commit .dev.vars, .env, *.sqlite, *.db, or node_modules.

## Scope discipline
- Do not fix bugs you were not asked to fix. Log them in
  docs/TECH_DEBT.md.
- Do not add features beyond what was requested.
- Do not refactor "while you are here".
- If you spot a problem, say so and let the human decide.

## Comment policy
- Comments explain WHY, not WHAT.
- Never reference build phases, specs, or prompts in comments.
- Never narrate change history in comments.
- TODOs live in docs/TECH_DEBT.md, not in source.

## Communication
Be concise. One recommendation, not a menu. Say uncomfortable
things proactively. Do not flatter.
