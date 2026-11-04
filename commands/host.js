import { PALETTE_SHORTCUTS, canonicalShortcut, commandShortcutError, eventShortcut } from "./keys.generated.mjs";

/** Marker the compiled palette puts on its dialog element. */
export const PALETTE_SELECTOR = "[data-nt-command-palette]";
const SEARCH_SELECTOR = "input[role=combobox]";
const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "Enter"]);
const TAB_STOPS = "input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]";
const installedRoots = new WeakSet();

function modifiersOf(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/**
 * Validate page-routed shortcuts with the same generated rules as the compiled registry and
 * return their canonical names (palette shortcuts included). Throws on grammar errors,
 * text-editing/reserved/palette shortcuts and duplicates after normalisation.
 */
export function commandKeySet(shortcuts = []) {
  if (!Array.isArray(shortcuts)) throw new TypeError("command shortcuts must be an array of strings");
  const owners = new Map();
  for (const shortcut of PALETTE_SHORTCUTS) owners.set(canonicalShortcut(shortcut), "palette");
  for (const shortcut of shortcuts) {
    if (typeof shortcut !== "string") throw new TypeError("command shortcuts must be an array of strings");
    const refused = commandShortcutError(shortcut);
    if (refused) throw new Error(refused);
    const name = canonicalShortcut(shortcut);
    if (owners.has(name)) throw new Error(`duplicate shortcut ${name} already owned by ${owners.get(name)}`);
    owners.set(name, shortcut);
  }
  return new Set(owners.keys());
}

/**
 * Page half of the command contract for one compiled mount root:
 * - suppresses browser defaults for palette and declared command shortcuts and routes those
 *   keys (and Escape while the palette is open) into the root when they start outside it;
 * - keeps the palette's navigation keys from moving the search caret or submitting forms,
 *   and keeps IME composition keys away from the palette;
 * - traps Tab/Shift+Tab and stray focus inside the open palette and restores the previously
 *   focused element after the palette closes or is disposed, unless a command moved focus;
 * - scrolls the active option into view.
 * Returns a disposer that removes every listener and observer.
 */
export function installCommandKeys(root, shortcuts = []) {
  if (!root || !root.ownerDocument || typeof root.querySelector !== "function") throw new TypeError("installCommandKeys needs a mount root element");
  if (installedRoots.has(root)) throw new Error("command keys are already installed for this root");
  const keys = commandKeySet(shortcuts);
  const document = root.ownerDocument, view = document.defaultView;
  const dialog = () => root.querySelector(PALETTE_SELECTOR);
  const isNode = (value) => value !== null && typeof value === "object" && typeof value.nodeType === "number";
  const tabStops = (open) => [...open.querySelectorAll(TAB_STOPS)].filter((element) => element.tabIndex >= 0 && !element.hidden);
  let restore = null, captured = false, wasOpen = !!dialog(), disposed = false;

  const forward = (event, target) => {
    if (isNode(target) && root.contains(target)) return;
    root.dispatchEvent(new view.KeyboardEvent("keydown", {
      key: event.key, code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, shiftKey: event.shiftKey, bubbles: true, cancelable: true,
    }));
  };
  const cycle = (open, delta) => {
    const stops = tabStops(open);
    if (stops.length === 0) return;
    const index = stops.indexOf(document.activeElement);
    const next = index < 0 ? (delta > 0 ? 0 : stops.length - 1) : (index + delta + stops.length) % stops.length;
    stops[next].focus({ preventScroll: true });
  };
  const onKeyDown = (event) => {
    const open = dialog(), target = event.target, modifiers = modifiersOf(event);
    const key = typeof event.key === "string" ? event.key : "", code = typeof event.code === "string" ? event.code : "";
    const inDialog = !!open && isNode(target) && open.contains(target);
    if (inDialog) {
      const searching = typeof target.matches === "function" && target.matches(SEARCH_SELECTOR);
      if (event.isComposing || event.keyCode === 229) {
        if (searching && (NAVIGATION_KEYS.has(key) || key === "Escape")) event.stopPropagation();
        return;
      }
      if (key === "Tab" && (modifiers === 0 || modifiers === 8)) { event.preventDefault(); cycle(open, modifiers === 8 ? -1 : 1); return; }
      if (searching && modifiers === 0 && NAVIGATION_KEYS.has(key)) event.preventDefault();
      if (key === "Escape" && modifiers === 0) event.preventDefault();
    }
    const name = eventShortcut(key, code, modifiers);
    if (name !== "" && keys.has(name)) { event.preventDefault(); forward(event, target); return; }
    if (open && !inDialog && name === "Escape") { event.preventDefault(); forward(event, target); }
  };
  const onFocusIn = (event) => {
    const open = dialog();
    if (!open) return;
    const target = event.target;
    if (isNode(target) && open.contains(target)) {
      if (!captured) {
        captured = true;
        const previous = event.relatedTarget;
        restore = isNode(previous) && !open.contains(previous) ? previous : null;
      }
      return;
    }
    // aria-modal: focus that escapes the open palette returns to its first tab stop.
    const stops = tabStops(open);
    if (stops.length > 0) stops[0].focus({ preventScroll: true });
  };
  const restoreFocus = () => {
    const target = restore;
    restore = null; captured = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (target && target.isConnected && typeof target.focus === "function") target.focus({ preventScroll: true });
  };
  const observer = new view.MutationObserver(() => {
    if (disposed) return;
    const open = dialog();
    if (open && !captured) {
      const active = document.activeElement;
      if (!open.contains(active)) {
        captured = true;
        restore = active && active !== document.body ? active : null;
        const stops = tabStops(open);
        if (stops.length > 0) stops[0].focus({ preventScroll: true });
      }
    }
    if (!open && wasOpen) restoreFocus();
    wasOpen = !!open;
    if (open) {
      const search = open.querySelector(SEARCH_SELECTOR), id = search && search.getAttribute("aria-activedescendant");
      const option = id ? document.getElementById(id) : null;
      if (option && open.contains(option) && typeof option.scrollIntoView === "function") option.scrollIntoView({ block: "nearest" });
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-activedescendant"] });
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  installedRoots.add(root);
  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    installedRoots.delete(root);
  };
}
