// Player input modes. The mode is set by the client on
// input actions and stored verbatim on the row — the server never
// remaps it. The TEXT transformation below runs on both ends: the
// client applies it before sending (so the optimistic overlay matches
// the persisted row), and the server applies it idempotently so
// direct API use persists the same text. The web app duplicates this
// rule in its own input-mode module (it cannot import server
// sources); both copies are unit-tested against the same cases.

export type InputMode = "do" | "say" | "story";

export function isInputMode(value: unknown): value is InputMode {
  return value === "do" || value === "say" || value === "story";
}

export function applyInputMode(text: string, mode: InputMode): string {
  if (mode === "do") {
    // Prefix "You " unless the input already reads as the player's
    // own agency ("you ..." or "i ...", case-insensitive).
    if (/^(you|i)\s/i.test(text)) {
      return text;
    }
    return `You ${text}`;
  }
  if (mode === "say") {
    // Wrap in double quotes unless already quoted.
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      return text;
    }
    return `"${text}"`;
  }
  return text;
}
