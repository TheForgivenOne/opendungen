---
description: Run the full verification suite and report counts
---
Run the complete verification suite for OpenDungen:

!pnpm -r typecheck && pnpm -r lint && pnpm -r format && pnpm -r test && pnpm -r build

Report the test counts (shared, web, api) and compare against the baseline recorded in PROGRESS.md.

If any step fails:
- Report the exact error.
- Do NOT fix it unless I ask.
- Log it in docs/TECH_DEBT.md if it is pre-existing.

If all steps pass, state: "All green. Counts match baseline."
