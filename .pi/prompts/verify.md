---
description: Run the full verification suite and report counts
---
Run the complete verification suite for OpenDungen:

1. pnpm -r typecheck
2. pnpm -r lint
3. pnpm -r format
4. pnpm -r test
5. pnpm -r build

Report the test counts (shared, web, api) and compare against the
baseline in PROGRESS.md.

If any step fails, report the exact error. Do NOT fix it unless I
ask. Log it in docs/TECH_DEBT.md if it is pre-existing.

If all steps pass, state: "All green. Counts match baseline."
