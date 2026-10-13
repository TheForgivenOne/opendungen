# OpenDungen Pi extensions

Project-local Pi extensions for the OpenDungen workflow. Auto-loaded
from `.pi/extensions/`.

| File | What it does |
|---|---|
| `opendungen-guards.ts` | Blocks writes to frozen files (`story.ts`, `prompts.ts`), blocks edits to applied migrations, prompts before dangerous bash (`rm -rf`, `git push`, `wrangler secret put`, etc.), warns on dirty working tree at session start |
| `opendungen-phase.ts` | Injects the phase protocol reminder when a phase-start prompt is detected; reminds you to commit after source changes |
| `opendungen-verify.ts` | Registers the `/verify` command |

## Disabling

Move the file out of `.pi/extensions/` or rename it to `.disabled`.
Pi will not load it.

## Editing

These are plain TypeScript. Edit, then `/reload` in a Pi session.
