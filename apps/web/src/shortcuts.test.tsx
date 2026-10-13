import { describe, expect, it } from "vitest";
import { act } from "./test-utils";
import { useRef } from "react";
import { SHORTCUTS, useStoryShortcuts } from "./shortcuts";
import { render } from "./test-utils";

function Harness({
  onCall,
  initial,
}: {
  onCall: (name: string) => void;
  initial?: Partial<{ streaming: boolean; draft: string; canModify: boolean }>;
}) {
  const draft = initial?.draft ?? "";
  const ref = useRef<HTMLElement | null>(null);
  const { onInputKeyDown } = useStoryShortcuts(
    ref,
    {
      onSend: () => onCall("send"),
      onStop: () => onCall("stop"),
      onUndo: () => onCall("undo"),
      onRetry: () => onCall("retry"),
    },
    {
      streaming: initial?.streaming ?? false,
      inputEmpty: draft === "",
      canModifyPair: initial?.canModify ?? true,
    },
  );
  return (
    <main ref={ref}>
      <textarea aria-label="input" value={draft} onChange={() => {}} onKeyDown={onInputKeyDown} />
    </main>
  );
}

function keydown(el: Element | Document, init: KeyboardEventInit): boolean {
  let defaultPrevented = false;
  act(() => {
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    el.dispatchEvent(event);
    defaultPrevented = event.defaultPrevented;
  });
  return defaultPrevented;
}

function textarea(container: ParentNode): HTMLElement {
  const input = container.querySelector("textarea");
  if (!input) {
    throw new Error("no textarea");
  }
  return input as HTMLElement;
}

describe("story shortcuts", () => {
  it("Enter sends, Shift+Enter does not", () => {
    const calls: string[] = [];
    const { container, unmount } = render(<Harness onCall={(name) => calls.push(name)} />);
    try {
      expect(keydown(textarea(container), { key: "Enter" })).toBe(true);
      expect(calls.filter((c) => c === "send")).toHaveLength(1);
      keydown(textarea(container), { key: "Enter", shiftKey: true });
      expect(calls.filter((c) => c === "send")).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("Esc aborts while streaming", () => {
    const calls: string[] = [];
    const { container, unmount } = render(
      <Harness onCall={(name) => calls.push(name)} initial={{ streaming: true }} />,
    );
    try {
      keydown(textarea(container), { key: "Escape" });
      expect(calls.filter((c) => c === "stop")).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("Cmd+R retries only with an empty input", () => {
    const calls: string[] = [];
    const { container, unmount } = render(
      <Harness onCall={(name) => calls.push(name)} initial={{ draft: "" }} />,
    );
    try {
      textarea(container).focus();
      expect(document.activeElement).toBe(textarea(container));
      const prevented = keydown(window.document, { key: "r", metaKey: true });
      expect(prevented).toBe(true);
      expect(calls.filter((c) => c === "retry")).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("Cmd+R with text in the input is left to the browser", () => {
    const calls: string[] = [];
    const { container, unmount } = render(
      <Harness onCall={(name) => calls.push(name)} initial={{ draft: "hello" }} />,
    );
    try {
      textarea(container).focus();
      const prevented = keydown(window.document, { key: "r", metaKey: true });
      expect(prevented).toBe(false);
      expect(calls.filter((c) => c === "retry")).toHaveLength(0);
    } finally {
      unmount();
    }
  });

  it("shortcuts are ignored when focus is outside the story view", () => {
    const calls: string[] = [];
    const { unmount } = render(<Harness onCall={(name) => calls.push(name)} />);
    try {
      document.body.focus();
      keydown(window.document, { key: "z", metaKey: true });
      expect(calls.filter((c) => c === "undo")).toHaveLength(0);
    } finally {
      unmount();
    }
  });

  it("Esc aborts at window level when the input has no focus", () => {
    const calls: string[] = [];
    const { unmount } = render(
      <Harness onCall={(name) => calls.push(name)} initial={{ streaming: true }} />,
    );
    try {
      // The textarea is disabled while streaming, so focus is on body.
      document.body.focus();
      keydown(window.document, { key: "Escape" });
      expect(calls.filter((c) => c === "stop")).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("documents every binding in the cheat-sheet list", () => {
    expect(SHORTCUTS.map((s) => s.keys)).toEqual([
      "Enter",
      "Shift+Enter",
      "Esc",
      "Cmd/Ctrl+Z",
      "Cmd/Ctrl+R",
      "Cmd/Ctrl+1/2/3",
      "Ctrl/Cmd+Up/Down",
      "Cmd/Ctrl+K",
    ]);
  });
});
