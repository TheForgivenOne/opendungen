// Ctrl+Up / Ctrl+Down input history: cycle the last 50
// input actions of the current story in the textarea. Pure cursor
// helpers so the stepping is unit-testable; the story view owns the
// history array (read from its actions) and the textarea state.

export interface InputHistoryCursor {
  // The user's in-progress text, restored when stepping past the end.
  saved: string;
  // Position in the inputs array; inputs.length means "past the end".
  index: number;
}

export function historyPrev(
  inputs: string[],
  cursor: InputHistoryCursor | null,
  draft: string,
): { text: string; cursor: InputHistoryCursor } {
  const base = cursor ?? { saved: draft, index: inputs.length };
  if (inputs.length === 0) {
    return { text: base.saved, cursor: base };
  }
  const next = Math.max(0, base.index - 1);
  return { text: inputs[next], cursor: { saved: base.saved, index: next } };
}

export function historyNext(
  inputs: string[],
  cursor: InputHistoryCursor | null,
): { text: string | null; cursor: InputHistoryCursor | null } {
  if (!cursor) {
    return { text: null, cursor: null };
  }
  const next = cursor.index + 1;
  if (next >= inputs.length) {
    return { text: cursor.saved, cursor: null };
  }
  return { text: inputs[next], cursor: { saved: cursor.saved, index: next } };
}
