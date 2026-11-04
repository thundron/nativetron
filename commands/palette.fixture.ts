// Owned browser fixture for commands/palette.test.mjs: compiled registry rules and palette behaviour.
import { setBinarySink, setLive, flush, dispatchSlot, dispatchSlotValue, dispatchSlotRich } from "../framework/core.js";
import { el, txt, dyn, attr, on, onEvent as listenOn, bindRef, focus, mountTo, unmount, type El, type ElementRef } from "../framework/ui.js";
import { signal, type Signal } from "../framework/reactive.js";
import {
  createCommandRegistry, commandPalette, enabledCommands, ariaShortcut, menuKeyShortcut, shortcutMenuKey, reserveMenuKey,
  COMMAND_LIMIT, type CommandRegistry,
} from "./index.js";
import { eventShortcut } from "./keys.generated.js";

declare function present(bytes: Uint8Array): void;

const runs = signal(0), last = signal("none"), otherEnters = signal(0);
const enabled: Signal<boolean>[] = [signal(true), signal(true), signal(true)];
const otherRef: ElementRef = { current: null };
const registry = createCommandRegistry();
let root: El = { roots: [], cleanups: [] };
let mounted = false;

function record(id: string): void { last.set(id); runs.set(runs.get() + 1); }

function build(): El {
  const other = listenOn(attr(attr(bindRef(el("input", []), otherRef), "id", "other-input"), "aria-label", "other"), "keydown", (event) => {
    if (event.key === "Enter" && (event.modifiers ?? 0) === 0) otherEnters.set(otherEnters.get() + 1);
  });
  return el("main", [
    other,
    attr(on(el("button", [txt("Toggle first")]), "click", () => enabled[0]!.set(!enabled[0]!.get())), "id", "toggle-first"),
    attr(el("p", [dyn(() => "runs=" + runs.get() + " last=" + last.get() + " other=" + otherEnters.get())]), "id", "log"),
    commandPalette(registry),
  ]);
}

export function start(): number {
  setBinarySink((bytes: Uint8Array) => present(bytes));
  registry.register({ id: "first", labelKey: "commands.title", shortcut: "Meta+j", enabled: enabled[0]!, run: () => record("first") });
  registry.register({ id: "second", labelKey: "commands.close", shortcut: "Control+Shift+1", enabled: enabled[1]!, run: () => record("second") });
  registry.register({ id: "third", labelKey: "commands.search", shortcut: "F2", enabled: enabled[2]!, run: () => { record("third"); focus(otherRef); } });
  root = build(); mounted = true;
  mountTo(root); setLive(); flush();
  return 0;
}

export function dispose(): number {
  if (mounted) { unmount(root); mounted = false; }
  flush();
  return 0;
}

export function remount(): number {
  if (mounted) return 1;
  root = build(); mounted = true;
  mountTo(root); flush();
  return 0;
}

export function setEnabled(index: number, value: number): number {
  if (index < 0 || index >= enabled.length) return 1;
  enabled[index]!.set(value !== 0);
  flush();
  return 0;
}

function throws(fn: () => void): boolean {
  try { fn(); } catch (_error) { return true; }
  return false;
}

function noop(): void {}

/** Returns 0 when every compiled registry rule holds, otherwise the number of the first failing check. */
export function registryTest(): number {
  const r: CommandRegistry = createCommandRegistry();
  const on1 = signal(true);
  let ran = 0;
  r.register({ id: "a", labelKey: "commands.title", shortcut: "Meta+Shift+k", enabled: on1, run: () => { ran++; } });
  if (!throws(() => r.register({ id: "a", labelKey: "commands.close", shortcut: "", enabled: on1, run: noop }))) return 1;
  if (!throws(() => r.register({ id: "b", labelKey: "commands.close", shortcut: "Shift+Meta+K", enabled: on1, run: noop }))) return 2;
  if (!throws(() => r.register({ id: "b", labelKey: "commands.close", shortcut: "Control+k", enabled: on1, run: noop }))) return 3;
  if (!throws(() => r.register({ id: "b", labelKey: "commands.close", shortcut: "Meta+K", enabled: on1, run: noop }))) return 4;
  if (!throws(() => r.register({ id: "b", labelKey: "commands.close", shortcut: "Meta+c", enabled: on1, run: noop }))) return 5;
  if (!throws(() => r.register({ id: "b", labelKey: "commands.close", shortcut: "Control+Tab", enabled: on1, run: noop }))) return 6;
  const refused = ["k", "Shift+k", "Alt+k", "Delete", "Enter", "Shift+Tab", "Command+k", "Meta+", "Meta+Space", ""];
  for (let i = 0; i < refused.length - 1; i++) {
    if (!throws(() => r.register({ id: "b", labelKey: "commands.close", shortcut: refused[i]!, enabled: on1, run: noop }))) return 10 + i;
  }
  if (!throws(() => r.register({ id: "b", labelKey: "missing.label", shortcut: "", enabled: on1, run: noop }))) return 20;
  if (!throws(() => r.register({ id: "b", labelKey: "greeting", shortcut: "", enabled: on1, run: noop }))) return 21;
  if (!throws(() => r.register({ id: "", labelKey: "commands.close", shortcut: "", enabled: on1, run: noop }))) return 22;
  if (r.commands.get().length !== 1 || r.owner("Shift+Meta+K") !== "command:a") return 23;
  if (r.owner("Control+k") !== "palette" || !r.owner("Meta+c").startsWith("system: ") || r.owner("Meta+s") !== "") return 24;
  if (!throws(() => r.owner("meta+s"))) return 25;
  if (!r.executeShortcut("Shift+Meta+K") || ran !== 1) return 26;
  on1.set(false);
  if (r.executeShortcut("Meta+Shift+k") || r.execute("a") || ran !== 1) return 27;
  if (enabledCommands(r, "").length !== 0) return 28;
  on1.set(true);
  if (enabledCommands(r, "  cOMM ").length !== 1 || enabledCommands(r, "close").length !== 0) return 29;
  r.register({ id: "f", labelKey: "commands.search", shortcut: "F5", enabled: on1, run: noop });
  if (r.owner("F5") !== "command:f" || r.execute("missing")) return 30;
  if (!r.unregister("a") || r.unregister("a") || r.owner("Meta+Shift+k") !== "" || r.executeShortcut("Meta+Shift+k")) return 31;
  r.register({ id: "b", labelKey: "commands.close", shortcut: "Shift+Meta+k", enabled: on1, run: noop });
  if (r.owner("Meta+Shift+k") !== "command:b") return 32;
  r.reserve("Meta+s", "menu:File/Save");
  if (!throws(() => r.register({ id: "s", labelKey: "commands.close", shortcut: "Meta+S", enabled: on1, run: noop }))) return 33;
  if (!throws(() => r.reserve("Meta+s", "menu:Other")) || !throws(() => r.reserve("Meta+j", "command:x")) || !throws(() => r.reserve("Meta+j", ""))) return 34;
  if (!throws(() => r.reserve("Meta+k", "menu:Palette")) || !throws(() => r.reserve("Meta+Shift+k", "menu:Taken"))) return 35;
  if (r.release("Meta+s", "menu:Other") || r.release("Meta+Shift+k", "command:b") || !r.release("Meta+s", "menu:File/Save")) return 36;
  r.register({ id: "s", labelKey: "commands.close", shortcut: "Meta+s", enabled: on1, run: noop });
  if (menuKeyShortcut("s") !== "Meta+s" || menuKeyShortcut("S") !== "Meta+Shift+s" || menuKeyShortcut("") !== "" || !throws(() => menuKeyShortcut("F1"))) return 40;
  if (shortcutMenuKey("Shift+Meta+p") !== "P" || shortcutMenuKey("Control+p") !== "" || shortcutMenuKey("Meta+1") !== "1" || shortcutMenuKey("Meta+F2") !== "") return 41;
  if (reserveMenuKey(r, "O", "menu:File/Open") !== "Meta+Shift+o" || r.owner("Shift+Meta+O") !== "menu:File/Open" || reserveMenuKey(r, "", "menu:None") !== "") return 42;
  if (!throws(() => reserveMenuKey(r, "s", "menu:File/Save"))) return 43;
  if (ariaShortcut("Shift+Meta+k") !== "Meta+Shift+K" || ariaShortcut("Control+F12") !== "Control+F12" || ariaShortcut("Alt+Control+ArrowUp") !== "Alt+Control+ArrowUp") return 44;
  if (eventShortcut("!", "Digit1", 10) !== "Control+Shift+1" || eventShortcut("˚", "KeyK", 1) !== "Alt+k" || eventShortcut("л", "KeyK", 4) !== "Meta+k") return 45;
  if (eventShortcut("a", "KeyQ", 2) !== "Control+a" || eventShortcut("Enter", "NumpadEnter", 0) !== "Enter" || eventShortcut("Shift", "ShiftLeft", 8) !== "" || eventShortcut("k", "KeyK", 16) !== "") return 46;
  const big = createCommandRegistry();
  for (let i = 0; i < COMMAND_LIMIT; i++) big.register({ id: "c" + i, labelKey: "commands.title", shortcut: "", enabled: on1, run: noop });
  if (!throws(() => big.register({ id: "overflow", labelKey: "commands.title", shortcut: "", enabled: on1, run: noop }))) return 50;
  if (big.commands.get().length !== COMMAND_LIMIT || enabledCommands(big, "commands").length !== COMMAND_LIMIT) return 51;
  return 0;
}

/* generated:event-export */
export function onEvent(
  slot: number,
): number {
  dispatchSlot(slot);
  flush();
  return 0;
}

export function onEventValue(
  slot: number,
  value: string,
): number {
  dispatchSlotValue(slot, value);
  flush();
  return 0;
}

export function onEventRich(
  slot: number,
  value: string,
  checked: number,
  key: string,
  code: string,
  modifiers: number,
  inputType: string,
  scrollTop: number,
): number {
  dispatchSlotRich(slot, value, checked, key, code, modifiers, inputType, scrollTop);
  flush();
  return 0;
}
/* /generated:event-export */
