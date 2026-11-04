// generated from commands/keys.json by commands/generate.mjs — do not edit
export interface Shortcut { key: string; modifiers: number; }
export const MODIFIER_NAMES: string[] = ["Alt","Control","Meta","Shift"];
export const MODIFIER_BITS: number[] = [1,2,4,8];
export const MODIFIER_MASK = 15;
export const NAMED_KEYS: string[] = ["Enter","Escape","ArrowUp","ArrowDown","Delete","Backspace","Tab","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"];
export const SHORTCUT_MAX_LENGTH = 64;
export const PALETTE_SHORTCUTS: string[] = ["Meta+k","Control+k"];
export const COMMAND_MODIFIER_MASK = 6;
export const UNMODIFIED_KEYS: string[] = ["F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"];
export const RESERVED_SHORTCUTS: string[] = ["Meta+q","Meta+w","Meta+h","Meta+m","Meta+t","Meta+n","Meta+Shift+t","Meta+Shift+n","Meta+Tab","Meta+Shift+Tab","Control+w","Control+t","Control+n","Control+Shift+t","Control+Shift+n","Control+Shift+w","Control+Tab","Control+Shift+Tab","Alt+F4","Meta+a","Meta+c","Meta+v","Meta+x","Control+a","Control+c","Control+v","Control+x"];
export const RESERVED_REASONS: string[] = ["quits the application","closes the window","hides the application","minimises the window","opens a browser tab","opens a browser window","reopens a browser tab","opens a private browser window","switches applications","switches applications","closes the browser tab","opens a browser tab","opens a browser window","reopens a browser tab","opens a private browser window","closes the browser window","switches browser tabs","switches browser tabs","closes the window","selects all text","copies text","pastes text","cuts text","selects all text","copies text","pastes text","cuts text"];
/** Parse the bounded grammar: distinct modifiers, then one alphanumeric, named key or function key. */
export function parseShortcut(value: string): Shortcut {
  if (value.length > SHORTCUT_MAX_LENGTH) throw new Error("shortcut too long: " + value.slice(0, SHORTCUT_MAX_LENGTH));
  const parts = value.split("+");
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let bit = 0;
    if (part === "Alt") bit = 1;
    if (part === "Control") bit = 2;
    if (part === "Meta") bit = 4;
    if (part === "Shift") bit = 8;
    if (!bit || (modifiers & bit)) throw new Error("invalid shortcut modifier: " + value);
    modifiers |= bit;
  }
  const key = parts[parts.length - 1]!;
  if (!/^[a-zA-Z0-9]$/.test(key) && !NAMED_KEYS.includes(key)) throw new Error("invalid shortcut key: " + value);
  return { key: key.toLowerCase(), modifiers };
}
/** Canonical spelling of a parsed key: lower-case alphanumerics, catalogue spelling for named keys. */
export function keyName(key: string): string {
  for (let i = 0; i < NAMED_KEYS.length; i++) if (NAMED_KEYS[i]!.toLowerCase() === key) return NAMED_KEYS[i]!;
  return key;
}
/** Canonical shortcut string: modifiers in bit order, then the canonical key. Equal shortcuts format identically. */
export function formatShortcut(shortcut: Shortcut): string {
  let out = "";
  for (let i = 0; i < MODIFIER_NAMES.length; i++) if (shortcut.modifiers & MODIFIER_BITS[i]!) out += MODIFIER_NAMES[i]! + "+";
  return out + keyName(shortcut.key);
}
export function canonicalShortcut(value: string): string { return formatShortcut(parseShortcut(value)); }
/** Index of a canonical shortcut in RESERVED_SHORTCUTS, or -1. */
export function reservedIndex(canonical: string): number {
  for (let i = 0; i < RESERVED_SHORTCUTS.length; i++) if (RESERVED_SHORTCUTS[i] === canonical) return i;
  return -1;
}
/** Empty when the shortcut may be owned by an application command, otherwise the refusal reason. */
export function commandShortcutError(value: string): string {
  const shortcut = parseShortcut(value), canonical = formatShortcut(shortcut);
  if ((shortcut.modifiers & COMMAND_MODIFIER_MASK) === 0 && !UNMODIFIED_KEYS.includes(keyName(shortcut.key))) return "command shortcut needs Control or Meta: " + canonical;
  const reserved = reservedIndex(canonical);
  if (reserved >= 0) return "reserved shortcut " + canonical + " " + RESERVED_REASONS[reserved]!;
  for (let i = 0; i < PALETTE_SHORTCUTS.length; i++) if (canonicalShortcut(PALETTE_SHORTCUTS[i]!) === canonical) return "shortcut " + canonical + " is owned by the command palette";
  return "";
}
/** Parse an application command shortcut, refusing text-editing, reserved and palette shortcuts. */
export function parseCommandShortcut(value: string): Shortcut {
  const error = commandShortcutError(value);
  if (error) throw new Error(error);
  return parseShortcut(value);
}
/**
 * Canonical shortcut for a keyboard event, or "" when the key is outside the grammar.
 * The layout-aware key wins; the physical code is the fallback when modifiers turn
 * a letter or digit into another character (Shift+1, Option+k, non-Latin layouts).
 */
export function eventShortcut(key: string, code: string, modifiers: number): string {
  if (modifiers < 0 || modifiers > MODIFIER_MASK || (modifiers | 0) !== modifiers || (modifiers & ~MODIFIER_MASK) !== 0) return "";
  let name = "";
  if (/^[a-zA-Z0-9]$/.test(key)) name = key.toLowerCase();
  else if (NAMED_KEYS.includes(key)) name = key.toLowerCase();
  else if (/^Key[A-Z]$/.test(code)) name = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) name = code.slice(5);
  else return "";
  return formatShortcut({ key: name, modifiers });
}
