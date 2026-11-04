import { parseShortcut, PALETTE_SHORTCUTS } from "./keys.generated.mjs";

export function installCommandKeys(root, shortcuts = []) {
  const keys = [...PALETTE_SHORTCUTS, ...shortcuts].map(parseShortcut);
  const document = root.ownerDocument;
  const listener = (event) => {
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    if (!keys.some((key) => key.key === event.key.toLowerCase() && key.modifiers === modifiers)) return;
    event.preventDefault();
    if (!root.contains(event.target)) root.dispatchEvent(new KeyboardEvent("keydown", {
      key: event.key, code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, shiftKey: event.shiftKey, bubbles: true,
    }));
  };
  document.addEventListener("keydown", listener);
  return () => document.removeEventListener("keydown", listener);
}
