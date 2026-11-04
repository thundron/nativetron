import { signal, computed, type Signal } from "../framework/reactive.js";
import { ROOT, on as listen, unlisten } from "../framework/core.js";
import { el, dyn, attr, dynAttr, on, onEvent, show, nothing, each, bindRef, focus, component, type El, type ElementRef, type KeyedItem } from "../framework/ui.js";
import { message } from "../i18n/index.js";
import {
  parseShortcut, canonicalShortcut, commandShortcutError, eventShortcut, keyName, reservedIndex,
  PALETTE_SHORTCUTS, RESERVED_REASONS, MODIFIER_NAMES, MODIFIER_BITS,
} from "./keys.generated.js";

export interface Command { id: string; labelKey: string; shortcut: string; enabled: Signal<boolean>; run: () => void; }
export interface CommandRegistry {
  commands: Signal<Command[]>;
  register: (command: Command) => void;
  execute: (id: string) => boolean;
  /** Remove a command and release its shortcut. */
  unregister: (id: string) => boolean;
  /** Execute the enabled command owning a shortcut (any spelling of it). */
  executeShortcut: (shortcut: string) => boolean;
  /** "" when free, otherwise "palette", "command:<id>", "system: <reason>" or a reservation owner. */
  owner: (shortcut: string) => string;
  /** Claim a shortcut for a non-command owner such as a native menu item. */
  reserve: (shortcut: string, owner: string) => void;
  /** Release a reservation made by `owner`. */
  release: (shortcut: string, owner: string) => boolean;
}

export const COMMAND_LIMIT = 1024;
export const RESERVATION_LIMIT = 1024;
export const COMMAND_ID_LIMIT = 128;
export const PALETTE_ID = "nt-command-palette";
const PALETTE_OWNER = "palette";
const COMMAND_OWNER = "command:";

function indexOfCommand(commands: Command[], id: string): number {
  for (let i = 0; i < commands.length; i++) if (commands[i]!.id === id) return i;
  return -1;
}

export function createCommandRegistry(): CommandRegistry {
  const commands = signal<Command[]>([]);
  const owners = new Map<string, string>();
  const shortcutCommands = new Map<string, string>();
  let reservations = 0;
  for (let i = 0; i < PALETTE_SHORTCUTS.length; i++) owners.set(canonicalShortcut(PALETTE_SHORTCUTS[i]!), PALETTE_OWNER);
  const execute = (id: string): boolean => {
    const current = commands.get();
    const index = indexOfCommand(current, id);
    if (index < 0) return false;
    const command = current[index]!;
    if (!command.enabled.get()) return false;
    command.run();
    return true;
  };
  return {
    commands,
    register: (command: Command) => {
      const current = commands.get();
      if (current.length >= COMMAND_LIMIT) throw new Error("command registry limit reached");
      if (!command.id || command.id.length > COMMAND_ID_LIMIT) throw new Error("invalid command id");
      if (indexOfCommand(current, command.id) >= 0) throw new Error("duplicate command id: " + command.id);
      // Missing catalogue keys and labels needing arguments throw before any state changes.
      message(command.labelKey);
      let name = "";
      if (command.shortcut) {
        const refused = commandShortcutError(command.shortcut);
        if (refused) throw new Error(refused);
        name = canonicalShortcut(command.shortcut);
        const owned = owners.get(name);
        if (owned !== undefined) throw new Error("duplicate shortcut " + name + " already owned by " + owned);
      }
      if (name) { owners.set(name, COMMAND_OWNER + command.id); shortcutCommands.set(name, command.id); }
      const next = current.slice(); next.push(command); commands.set(next);
    },
    execute,
    unregister: (id: string): boolean => {
      const current = commands.get();
      const index = indexOfCommand(current, id);
      if (index < 0) return false;
      const command = current[index]!;
      if (command.shortcut) {
        const name = canonicalShortcut(command.shortcut);
        owners.delete(name); shortcutCommands.delete(name);
      }
      const next = current.slice(); next.splice(index, 1); commands.set(next);
      return true;
    },
    executeShortcut: (shortcut: string): boolean => {
      const id = shortcutCommands.get(canonicalShortcut(shortcut));
      return id !== undefined && execute(id);
    },
    owner: (shortcut: string): string => {
      const name = canonicalShortcut(shortcut);
      const owned = owners.get(name);
      if (owned !== undefined) return owned;
      const reserved = reservedIndex(name);
      return reserved >= 0 ? "system: " + RESERVED_REASONS[reserved]! : "";
    },
    reserve: (shortcut: string, owner: string) => {
      if (!owner || owner.length > COMMAND_ID_LIMIT || owner === PALETTE_OWNER || owner.startsWith(COMMAND_OWNER) || owner.startsWith("system")) throw new Error("invalid shortcut owner: " + owner);
      if (reservations >= RESERVATION_LIMIT) throw new Error("shortcut reservation limit reached");
      const name = canonicalShortcut(shortcut);
      const owned = owners.get(name);
      if (owned !== undefined) throw new Error("duplicate shortcut " + name + " already owned by " + owned);
      owners.set(name, owner);
      reservations++;
    },
    release: (shortcut: string, owner: string): boolean => {
      const name = canonicalShortcut(shortcut);
      if (!owner || owners.get(name) !== owner || owner === PALETTE_OWNER || owner.startsWith(COMMAND_OWNER)) return false;
      owners.delete(name);
      reservations--;
      return true;
    },
  };
}

export function enabledCommands(registry: CommandRegistry, query: string): Command[] {
  const result: Command[] = [], needle = query.toLowerCase().trim(), commands = registry.commands.get();
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    if (command.enabled.get() && message(command.labelKey).toLowerCase().includes(needle)) result.push(command);
  }
  return result;
}

function modifierBit(name: string): number {
  for (let i = 0; i < MODIFIER_NAMES.length; i++) if (MODIFIER_NAMES[i] === name) return MODIFIER_BITS[i]!;
  return 0;
}

/** `aria-keyshortcuts` spelling: modifiers in canonical order, letters upper-case. */
export function ariaShortcut(shortcut: string): string {
  const parsed = parseShortcut(shortcut);
  let out = "";
  for (let i = 0; i < MODIFIER_NAMES.length; i++) if (parsed.modifiers & MODIFIER_BITS[i]!) out += MODIFIER_NAMES[i]! + "+";
  return out + (/^[a-z]$/.test(parsed.key) ? parsed.key.toUpperCase() : keyName(parsed.key));
}

/**
 * Native application menu key equivalent (macOS `keyEquivalent`, implicit Command) as a
 * shortcut: "s" is Meta+s, "S" is Meta+Shift+s, "" has no shortcut. Reserve the result
 * so a command cannot also own it.
 */
export function menuKeyShortcut(key: string): string {
  if (key === "") return "";
  if (/^[a-z0-9]$/.test(key)) return "Meta+" + key;
  if (/^[A-Z]$/.test(key)) return "Meta+Shift+" + key.toLowerCase();
  throw new Error("unsupported native menu key: " + key);
}

/** Key equivalent for a shortcut a native menu can express, otherwise "". */
export function shortcutMenuKey(shortcut: string): string {
  const parsed = parseShortcut(shortcut), meta = modifierBit("Meta"), shift = modifierBit("Shift");
  if (!/^[a-z0-9]$/.test(parsed.key)) return "";
  if (parsed.modifiers === meta) return parsed.key;
  if (parsed.modifiers === (meta | shift) && /^[a-z]$/.test(parsed.key)) return parsed.key.toUpperCase();
  return "";
}

/** Reserve a native menu item's key equivalent for `owner`; returns the canonical shortcut or "". */
export function reserveMenuKey(registry: CommandRegistry, key: string, owner: string): string {
  const shortcut = menuKeyShortcut(key);
  if (shortcut === "") return "";
  registry.reserve(shortcut, owner);
  return canonicalShortcut(shortcut);
}

let paletteMounted = false;
let optionSerial = 0;

/** Owned command palette; see commands/README.md for the keyboard and focus contract. */
export function commandPalette(registry: CommandRegistry): El {
  if (paletteMounted) throw new Error("only one command palette may own root shortcuts");
  paletteMounted = true;
  try {
    return component(() => buildPalette(registry));
  } catch (error) {
    paletteMounted = false;
    throw error;
  }
}

function buildPalette(registry: CommandRegistry): El {
  const opened = signal(false), query = signal(""), active = signal(0);
  const inputRef: ElementRef = { current: null };
  const optionIds = new Map<string, string>();
  const paletteKeys: string[] = [];
  for (let i = 0; i < PALETTE_SHORTCUTS.length; i++) paletteKeys.push(canonicalShortcut(PALETTE_SHORTCUTS[i]!));
  const matches = computed<Command[]>(() => {
    if (!opened.get()) return [];
    return enabledCommands(registry, query.get());
  });
  const activeIndex = (): number => {
    const count = matches.get().length, index = active.get();
    if (count === 0) return -1;
    return index < 0 ? 0 : index >= count ? count - 1 : index;
  };
  const activeId = computed<string>(() => {
    const index = activeIndex();
    return index < 0 ? "" : matches.get()[index]!.id;
  });
  const optionId = (id: string): string => {
    const known = optionIds.get(id);
    if (known !== undefined) return known;
    optionSerial++;
    const next = PALETTE_ID + "-option-" + optionSerial;
    optionIds.set(id, next);
    return next;
  };
  const close = () => {
    if (!opened.get()) return;
    opened.set(false); query.set(""); active.set(0);
    optionIds.clear();
  };
  const open = () => {
    query.set(""); active.set(0); opened.set(true);
    focus(inputRef);
  };
  // Close first so the command runs against a settled UI and may move focus or reopen the palette.
  const runCommand = (id: string) => { close(); registry.execute(id); };
  const move = (delta: number) => {
    const count = matches.get().length;
    if (count === 0) return;
    active.set((activeIndex() + delta + count) % count);
  };

  listen(ROOT, "keydown", (event) => {
    const name = eventShortcut(event.key ?? "", event.code ?? "", event.modifiers ?? 0);
    if (name === "") return;
    if (paletteKeys.includes(name)) {
      if (opened.get()) close(); else open();
      return;
    }
    if (name === "Escape") { close(); return; }
    const owner = registry.owner(name);
    if (!owner.startsWith(COMMAND_OWNER)) return;
    const id = owner.slice(COMMAND_OWNER.length), current = registry.commands.get(), index = indexOfCommand(current, id);
    if (index >= 0 && current[index]!.enabled.get()) runCommand(id);
  });

  const option = (command: Command): El => {
    let button = attr(attr(attr(attr(el("button", [dyn(() => message(command.labelKey))]), "type", "button"), "role", "option"), "tabindex", "-1"), "id", optionId(command.id));
    if (command.shortcut) button = attr(button, "aria-keyshortcuts", ariaShortcut(command.shortcut));
    dynAttr(button, "aria-selected", () => activeId.get() === command.id ? "true" : "false");
    return on(button, "click", () => runCommand(command.id));
  };

  const palette = show(() => opened.get(), () => {
    let input = bindRef(el("input", []), inputRef);
    input = attr(attr(attr(attr(attr(attr(input, "type", "text"), "role", "combobox"), "aria-autocomplete", "list"), "aria-expanded", "true"), "aria-controls", PALETTE_ID + "-list"), "autocomplete", "off");
    input = attr(input, "spellcheck", "false");
    dynAttr(input, "aria-label", () => message("commands.search"));
    dynAttr(input, "aria-activedescendant", () => { const id = activeId.get(); return id ? optionId(id) : ""; });
    onEvent(input, "input", (event) => { query.set(event.value); active.set(0); });
    // Navigation keys are owned by the search input only; Enter elsewhere is never taken.
    onEvent(input, "keydown", (event) => {
      if ((event.modifiers ?? 0) !== 0) return;
      const key = event.key ?? "";
      if (key === "ArrowDown") move(1);
      else if (key === "ArrowUp") move(-1);
      else if (key === "Home") { if (matches.get().length > 0) active.set(0); }
      else if (key === "End") { if (matches.get().length > 0) active.set(matches.get().length - 1); }
      else if (key === "Enter") { const id = activeId.get(); if (id) runCommand(id); }
    });
    const list = attr(attr(each("div", () => {
      const current = matches.get(), items: KeyedItem[] = [];
      for (let i = 0; i < current.length; i++) {
        const command = current[i]!;
        items.push({ key: command.id, build: () => option(command) });
      }
      return items;
    }), "role", "listbox"), "id", PALETTE_ID + "-list");
    dynAttr(list, "aria-label", () => message("commands.title"));
    const empty = show(() => matches.get().length === 0, () => attr(el("p", [dyn(() => message("commands.empty"))]), "role", "status"), () => nothing());
    const title = attr(el("h2", [dyn(() => message("commands.title"))]), "id", PALETTE_ID + "-title");
    const closeButton = on(attr(el("button", [dyn(() => message("commands.close"))]), "type", "button"), "click", close);
    let dialog = attr(attr(el("section", [title, input, list, empty, closeButton]), "role", "dialog"), "aria-modal", "true");
    dialog = attr(attr(dialog, "aria-labelledby", PALETTE_ID + "-title"), "data-nt-command-palette", "");
    return dialog;
  }, () => nothing());
  palette.cleanups.push(() => { unlisten(ROOT, "keydown"); paletteMounted = false; });
  return palette;
}
