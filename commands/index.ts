import { signal, type Signal } from "../framework/reactive.js";
import { ROOT, on as listen, unlisten } from "../framework/core.js";
import { el, txt, dyn, attr, on, onEvent, show, nothing, each, bindRef, focus, type El, type ElementRef, type KeyedItem } from "../framework/ui.js";
import { message } from "../i18n/index.js";
import { parseShortcut, PALETTE_SHORTCUTS, type Shortcut } from "./keys.generated.js";

export interface Command { id: string; labelKey: string; shortcut: string; enabled: Signal<boolean>; run: () => void; }
export interface CommandRegistry { commands: Signal<Command[]>; register: (command: Command) => void; execute: (id: string) => boolean; }
export function createCommandRegistry(): CommandRegistry {
  const commands = signal<Command[]>([]);
  return {
    commands,
    register: (command: Command) => {
      const current = commands.get();
      if (!command.id || current.length >= 1024) throw new Error("invalid command id or registry limit");
      message(command.labelKey);
      const shortcut = command.shortcut ? parseShortcut(command.shortcut) : { key: "", modifiers: 0 };
      for (let i = 0; i < current.length; i++) {
        const other = current[i]!.shortcut ? parseShortcut(current[i]!.shortcut) : { key: "", modifiers: 0 };
        if (current[i]!.id === command.id || (shortcut.key && shortcut.key === other.key && shortcut.modifiers === other.modifiers)) throw new Error("duplicate command id or shortcut");
      }
      const next = current.slice(); next.push(command); commands.set(next);
    },
    execute: (id: string): boolean => {
      const current = commands.get();
      for (let i = 0; i < current.length; i++) {
        const command = current[i]!;
        if (command.id === id && command.enabled.get()) { command.run(); return true; }
      }
      return false;
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
let paletteMounted = false;
export function commandPalette(registry: CommandRegistry): El {
  if (paletteMounted) throw new Error("only one command palette may own root shortcuts");
  paletteMounted = true;
  const opened = signal(false), query = signal("");
  const inputRef: ElementRef = { current: null };
  const paletteKeys: Shortcut[] = [];
  for (let i = 0; i < PALETTE_SHORTCUTS.length; i++) paletteKeys.push(parseShortcut(PALETTE_SHORTCUTS[i]!));
  const close = () => { opened.set(false); query.set(""); };
  listen(ROOT, "keydown", (event) => {
    const key = (event.key ?? "").toLowerCase(), modifiers = event.modifiers ?? 0;
    for (let i = 0; i < paletteKeys.length; i++) {
      if (paletteKeys[i]!.key === key && paletteKeys[i]!.modifiers === modifiers) {
        opened.set(!opened.get());
        if (opened.get()) focus(inputRef);
        return;
      }
    }
    if (opened.get() && key === "escape") { close(); return; }
    if (opened.get() && key === "enter") {
      const matches = enabledCommands(registry, query.get());
      if (matches.length > 0) { registry.execute(matches[0]!.id); close(); }
      return;
    }
    const commands = registry.commands.get();
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i]!;
      if (!command.shortcut) continue;
      const shortcut = parseShortcut(command.shortcut);
      if (shortcut.key === key && shortcut.modifiers === modifiers) { registry.execute(command.id); return; }
    }
  });
  const palette = show(() => opened.get(), () => {
    const input = onEvent(bindRef(attr(el("input", []), "aria-label", message("commands.search")), inputRef), "input", (event) => query.set(event.value));
    const list = each("div", () => {
      const commands = enabledCommands(registry, query.get()), items: KeyedItem[] = [];
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i]!;
        items.push({ key: command.id, build: () => on(attr(el("button", [dyn(() => message(command.labelKey))]), "type", "button"), "click", () => { registry.execute(command.id); close(); }) });
      }
      return items;
    });
    return attr(attr(el("section", [el("h2", [txt(message("commands.title"))]), input, list,
      show(() => enabledCommands(registry, query.get()).length === 0, () => el("p", [txt(message("commands.empty"))]), () => nothing()),
      on(el("button", [txt(message("commands.close"))]), "click", close),
    ]), "role", "dialog"), "aria-modal", "true");
  }, () => nothing());
  palette.cleanups.push(() => { unlisten(ROOT, "keydown"); paletteMounted = false; });
  return palette;
}
