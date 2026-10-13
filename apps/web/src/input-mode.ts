// Player input modes (Phase 6): do / say / story. The client
// transforms the text before sending (so the optimistic overlay
// matches the persisted row); the server applies the same idempotent
// rule, and stores the mode for rendering. The API duplicates this
// rule in its own input-mode module (the web app cannot import server
// sources); both copies are unit-tested against the same cases.

export type InputMode = "do" | "say" | "story";

export const INPUT_MODES: { value: InputMode; label: string; placeholder: string }[] = [
  { value: "do", label: "Do", placeholder: "What do you do?" },
  { value: "say", label: "Say", placeholder: "What do you say?" },
  { value: "story", label: "Story", placeholder: "What happens next?" },
];

export const INPUT_MODE_KEY = "opendungen.inputMode";

export function isInputMode(value: unknown): value is InputMode {
  return value === "do" || value === "say" || value === "story";
}

export function applyInputMode(text: string, mode: InputMode): string {
  if (mode === "do") {
    if (/^(you|i)\s/i.test(text)) {
      return text;
    }
    return `You ${text}`;
  }
  if (mode === "say") {
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      return text;
    }
    return `"${text}"`;
  }
  return text;
}

export function readStoredInputMode(): InputMode {
  try {
    const raw = window.localStorage.getItem(INPUT_MODE_KEY);
    if (isInputMode(raw)) {
      return raw;
    }
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return "do";
}

export function storeInputMode(mode: InputMode): void {
  try {
    window.localStorage.setItem(INPUT_MODE_KEY, mode);
  } catch {
    // Private mode etc: the mode still works for this session.
  }
}

export function placeholderForMode(mode: InputMode): string {
  return INPUT_MODES.find((m) => m.value === mode)?.placeholder ?? "What do you do?";
}
