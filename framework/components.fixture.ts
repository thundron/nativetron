import { setBinarySink, setLive, flush, dispatchSlot, dispatchSlotValue, dispatchSlotRich } from "./core.js";
import { el, txt, dyn, attr, on, mountTo, unmount, type El } from "./ui.js";
import { signal } from "./reactive.js";
import { virtualList, virtualTable, visibleRange } from "./virtual.js";
import { createCommandRegistry, commandPalette } from "../commands/index.js";
import { message, numberArgument, textArgument, formatNumber, formatUnit, setLocaleFormatter, pullLocaleFormatter } from "../i18n/index.js";

declare function present(bytes: Uint8Array): void;
declare function localeFormatBegin(value: number, locale: string, unit: string, digits: number, capacity: number): number;
declare function localeFormatByte(index: number): number;
const count = signal(10000), enabled = signal(true), executions = signal(0), scrollTop = signal(0);
const registry = createCommandRegistry();
let root: El = { roots: [], cleanups: [] };

export function start(): number {
  setBinarySink((bytes: Uint8Array) => present(bytes));
  setLocaleFormatter(pullLocaleFormatter(
    (value: number, locale: string, unit: string, digits: number, capacity: number) => localeFormatBegin(value, locale, unit, digits, capacity),
    (index: number) => localeFormatByte(index),
  ));
  registry.register({ id: "hello", labelKey: "commands.title", shortcut: "Meta+j", enabled, run: () => executions.set(executions.get() + 1) });
  const list = attr(virtualList({ count: () => count.get(), key: (index: number) => "row-" + index,
    render: (index: number) => attr(el("span", [txt("row " + index)]), "data-row", "" + index),
    rowHeight: 24, height: 240, overscan: 3, scrollTop,
  }), "id", "virtual-test");
  root = el("main", [
    el("p", [txt(message("greeting", [textArgument("name", "world")]))]),
    el("p", [dyn(() => message("items.count", [numberArgument("count", count.get())]))]),
    el("p", [txt(formatNumber(12345.678, 2) + " / " + formatUnit(1.5, "meter", 1))]),
    on(el("button", [txt("Disable command")]), "click", () => enabled.set(false)),
    on(el("button", [txt("Shrink list")]), "click", () => count.set(5)),
    attr(el("p", [dyn(() => "executions=" + executions.get())]), "id", "command-result"),
    list, attr(virtualTable(() => count.get(), (row: number) => "row-" + row, [
      { header: "Index", cell: (row: number) => txt("" + row) },
      { header: "Label", cell: (row: number) => txt("entry " + row) },
    ], 24, 120), "id", "table-test"), commandPalette(registry),
  ]);
  mountTo(root); setLive(); flush();
  return 0;
}
export function dispose(): number { unmount(root); flush(); return 0; }
export function rangeTest(): number {
  const middle = visibleRange(10000, 24, 240, 120000, 3);
  if (middle.first !== 4997 || middle.end !== 5013 || middle.top !== 119928 || middle.bottom !== 119688) return 0;
  const empty = visibleRange(0, 24, 240, 0, 3);
  return empty.first === 0 && empty.end === 0 ? 1 : 0;
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
  clientHeight: number,
): number {
  dispatchSlotRich(slot, value, checked, key, code, modifiers, inputType, scrollTop, clientHeight);
  flush();
  return 0;
}
/* /generated:event-export */
