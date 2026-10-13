import { describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { ToastProvider, useToast } from "./toast";
import { click, getByText, queryByText, render } from "./test-utils";

describe("toasts", () => {
  it("pushes and auto-dismisses", () => {
    vi.useFakeTimers();
    try {
      function Fires() {
        const { push } = useToast();
        return <button onClick={() => push("error", "boom happened")}>fire</button>;
      }
      const { container, unmount } = render(
        <ToastProvider>
          <Fires />
        </ToastProvider>,
      );
      try {
        click(getByText(container, "fire"));
        const toast = getByText(container, "boom happened");
        expect(toast.getAttribute("role")).toBe("alert");
        act(() => {
          vi.advanceTimersByTime(4100);
        });
        expect(queryByText(container, "boom happened")).toBeNull();
      } finally {
        unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
