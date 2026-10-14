---
name: opendungen-prompts
description: OpenDungen prompt architecture — the 10-layer narrative prompt, scenario instruction contract, Author's Note semantics, and the eval script. Use when changing anything in apps/api/src/context/prompts.ts or assemble.ts.
---

# OpenDungen Prompt Architecture

## The 10 layers
1. BASE_SYSTEM_PROMPT — always first
2. OUTPUT_CONSTRAINTS — always second
3. Scenario instructions — per scenario, may be empty
4. Mode directive — per turn (do/say/story/continue)
5. Plot Essentials
6. Story Summary
7. Story Cards ("World Lore:")
8. Recent history (verbatim turns)
9. Author's Note — after history, wrapped in [brackets]
10. Current input — formatted by mode

Source of truth: apps/api/src/context/prompts.ts.

## Frozen text
The string constants in prompts.ts are VERBATIM. Do not paraphrase, reflow, or "improve" them.

## Scenario instruction contract
Scenario `aiInstructions` APPENDS to the base prompt. It does not replace it. It may add tone, setting rules, genre constraints. It may NOT override length target, player agency, anti-summarization, or the end-on-a-hook constraint.

## Author's Note
The `memory` field behaves like AI Dungeon's Author's Note: short (3-4 sentences), square-bracketed when sent, placed after history, for tone reminders and immediate directives.

## Budget and trimming
Required cap: 70% of total tokens. Trim order: Story cards → Author's Note → Story summary (floor 100 tokens) → Plot essentials. Never trim: base, constraints, mode directive, last action.

## Eval
Prompt changes must be evaluated with `pnpm --filter api eval-prompt`. Read the outputs. Compare old vs new. Do not tune the prompt without running the eval first.
