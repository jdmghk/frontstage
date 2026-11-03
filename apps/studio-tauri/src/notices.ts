// A small message strip for things the editor's own UI has no place for: clip conversion, and keys
// that must be re-entered. Plain DOM, so it can show before and outside the React tree.

import { theme } from "@frontstage/ui";

const STACK_ID = "frontstage-notices";

function stack(): HTMLElement {
  let el = document.getElementById(STACK_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STACK_ID;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.cssText = "position:fixed;left:12px;bottom:12px;max-width:440px;display:flex;flex-direction:column;gap:6px;z-index:2147483000";
    document.body.appendChild(el);
  }
  return el;
}

export interface Notice {
  set(text: string): void;
  dismissAfter(ms: number): void;
  remove(): void;
}

/** `onDismiss` adds a close button. */
export function showNotice(testid: string, text: string, onDismiss?: () => void): Notice {
  const row = document.createElement("div");
  row.dataset.testid = testid;
  row.style.cssText = `display:flex;gap:8px;align-items:flex-start;padding:8px 10px;font:12px/1.4 system-ui,sans-serif;border-radius:6px;background:${theme.bg.raised};color:${theme.text.primary};border:1px solid ${theme.border.primary}`;
  const label = document.createElement("span");
  label.style.flex = "1";
  label.textContent = text;
  row.appendChild(label);
  const remove = () => row.remove();
  if (onDismiss) {
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Dismiss";
    close.dataset.testid = `${testid}-dismiss`;
    close.style.cssText = `background:none;border:0;padding:0;cursor:pointer;font:inherit;text-decoration:underline;color:${theme.text.secondary}`;
    close.onclick = () => {
      remove();
      onDismiss();
    };
    row.appendChild(close);
  }
  stack().appendChild(row);
  return {
    set: (t) => {
      label.textContent = t;
    },
    dismissAfter: (ms) => {
      setTimeout(remove, ms);
    },
    remove,
  };
}
