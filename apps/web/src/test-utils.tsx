// Hand-rolled render helpers (no component-test library): mount with
// createRoot inside act(), plus tiny DOM queries.

import * as React from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

// React's named ESM export breaks under vitest's interop; the namespace
// object carries a working act(). Re-exported for all frontend tests.
export const act: typeof React.act = React.act;

export function render(ui: ReactNode): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function getByText(container: ParentNode, text: string): HTMLElement {
  const found = Array.from(container.querySelectorAll("*")).find(
    (el) => el.children.length === 0 && (el.textContent ?? "").trim() === text,
  );
  if (!found) {
    throw new Error(`no element with text "${text}"`);
  }
  return found as HTMLElement;
}

export function queryByText(container: ParentNode, text: string): HTMLElement | null {
  const found = Array.from(container.querySelectorAll("*")).find(
    (el) => el.children.length === 0 && (el.textContent ?? "").trim() === text,
  );
  return (found as HTMLElement | undefined) ?? null;
}

export function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) {
    throw new Error("no value setter");
  }
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
