import { setBinarySink, setLive, flush, dispatchSlot, dispatchSlotValue, dispatchSlotRich } from "./core.js";
import { el, txt, dyn, attr, on, onEvent as listenEvent, dynProp, mountTo, unmount, type El } from "./ui.js";
import { signal } from "./reactive.js";
import { virtualList, keyedVirtualList, virtualTable, virtualStats, scrollToIndex, type VirtualRow } from "./virtual.js";

declare function present(bytes: Uint8Array): void;

// Application state lives outside rows so it survives row disposal.
const countA = signal(10000), viewA = signal(240), activeA = signal(-1), scrollA = signal(0), shiftA = signal(0);
const labels = new Map<number, string>();
const labelVersion = signal(0);
const countC = signal(1000), viewC = signal(120), scrollC = signal(0), tableVersion = signal(0);
const scrollB = signal(0), scrollD = signal(0);
const itemsB = signal<string[]>(initialItems());
let root: El = { roots: [], cleanups: [] };
let mounted = false;

function initialItems(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 200; i++) out.push("k" + i);
  return out;
}
function labelOf(index: number): string {
  return labels.get(index) ?? "";
}

function rowA(index: number): El {
  const input = attr(el("input", []), "data-input", "" + index);
  dynProp(input, "value", () => { labelVersion.get(); return labelOf(index); });
  listenEvent(input, "input", (event) => { labels.set(index, event.value); labelVersion.set(labelVersion.get() + 1); });
  listenEvent(input, "focus", (_event) => { activeA.set(index); });
  listenEvent(input, "blur", (_event) => { if (activeA.get() === index) activeA.set(-1); });
  return attr(el("div", [
    attr(el("span", [txt("row " + index)]), "data-label", "" + index),
    attr(el("span", [dyn(() => { labelVersion.get(); return "=" + labelOf(index); })]), "data-echo", "" + index),
    input,
  ]), "data-row", "" + index);
}

function rowB(row: VirtualRow): El {
  // Row-local state: survives index changes while the key stays mounted, disposed when the row leaves.
  const clicks = signal(0);
  return attr(el("div", [
    txt(row.key),
    attr(el("span", [dyn(() => "@" + row.index())]), "data-index", ""),
    attr(on(el("button", [dyn(() => "clicks " + clicks.get())]), "click", () => clicks.set(clicks.get() + 1)), "data-click", row.key),
  ]), "data-key", row.key);
}

function build(): El {
  const listA = attr(virtualList({
    count: () => countA.get(), key: (index: number) => "row-" + (index + shiftA.get()), render: rowA,
    rowHeight: 24, height: 240, overscan: 3, scrollTop: scrollA, viewport: viewA, activeIndex: activeA, label: "Rows",
  }), "id", "list-a");
  const listB = attr(keyedVirtualList({
    count: () => itemsB.get().length, key: (index: number) => itemsB.get()[index]!, renderRow: rowB,
    rowHeight: 20, height: 200, overscan: 2, scrollTop: scrollB,
  }), "id", "list-b");
  const table = attr(virtualTable(() => countC.get(), (row: number) => "t" + row, [
    { header: "Index", cell: (row: number) => txt("" + row) },
    { header: "Entry", cell: (row: number) => txt("entry " + row + " v" + tableVersion.get()) },
  ], 24, 120, { viewport: viewC, scrollTop: scrollC, label: "Table" }), "id", "table-c");
  const listD = attr(virtualList({
    count: () => 1000000, key: (index: number) => "h" + index,
    render: (index: number) => attr(el("span", [txt("huge " + index)]), "data-huge", "" + index),
    rowHeight: 16, height: 320, overscan: 3, scrollTop: scrollD,
  }), "id", "list-d");
  return el("main", [listA, listB, table, listD]);
}

export function start(): number {
  setBinarySink((bytes: Uint8Array) => present(bytes));
  if (!mounted) {
    root = build();
    mountTo(root);
    mounted = true;
  }
  setLive(); flush();
  return 0;
}
export function dispose(): number {
  if (mounted) { unmount(root); mounted = false; }
  flush();
  return 0;
}
export function statsLists(): number { return virtualStats().lists; }
export function statsRows(): number { return virtualStats().rows; }
export function scrollValueA(): number { return scrollA.get(); }
export function scrollValueB(): number { return scrollB.get(); }
export function activeValueA(): number { return activeA.get(); }
export function setCountA(count: number): number { countA.set(count); return 0; }
export function setViewA(height: number): number { viewA.set(height); return 0; }
export function setActiveA(index: number): number { activeA.set(index); return 0; }
export function setShiftA(shift: number): number { shiftA.set(shift); return 0; }
export function setCountC(count: number): number { countC.set(count); return 0; }
export function setViewC(height: number): number { viewC.set(height); return 0; }
export function bumpTable(): number { tableVersion.set(tableVersion.get() + 1); return 0; }
export function editLabel(index: number, text: string): number { labels.set(index, text); labelVersion.set(labelVersion.get() + 1); return 0; }
export function reverseB(): number { const next = itemsB.get().slice(); next.reverse(); itemsB.set(next); return 0; }
export function rotateB(): number { const next = itemsB.get().slice(); const head = next.shift()!; next.push(head); itemsB.set(next); return 0; }
export function resetB(): number { itemsB.set(initialItems()); return 0; }
export function setCountB(count: number): number { itemsB.set(initialItems().slice(0, count)); return 0; }
/** Inserts a duplicate of `at`'s key at `target`; returns 1 when the write refused. */
export function duplicateB(at: number, target: number): number {
  const next = itemsB.get().slice();
  next[target] = next[at]!;
  try { itemsB.set(next); } catch { return 1; }
  return 0;
}
export function invalidCountA(): number {
  try { countA.set(-1); } catch { countA.set(10000); return 1; }
  return 0;
}
/** Mounts and disposes a full fresh tree `n` times while scrolling, reordering and editing. */
export function cycle(n: number): number {
  const wasMounted = mounted;
  if (mounted) { unmount(root); mounted = false; }
  for (let i = 0; i < n; i++) {
    const tree = build();
    mountTo(tree);
    flush();
    scrollA.set((i * 7919) % 200000);
    scrollB.set((i * 131) % 3800);
    scrollC.set((i * 977) % 20000);
    scrollD.set((i * 104729) % 15000000);
    activeA.set(i % 3 === 0 ? 9000 : -1);
    reverseB();
    tableVersion.set(tableVersion.get() + 1);
    flush();
    unmount(tree);
  }
  scrollA.set(0); scrollB.set(0); scrollC.set(0); scrollD.set(0); activeA.set(-1); resetB();
  if (wasMounted) { root = build(); mountTo(root); mounted = true; }
  flush();
  return 0;
}

let autoRoot: El = { roots: [], cleanups: [] };
const autoScroll = signal(480), autoViewport = signal(240);
export function startAuto(): number {
  const list = attr(virtualList({ count: () => 10000, key: index => "a" + index,
    render: index => attr(el("span", [txt("auto " + index)]), "data-auto", "" + index),
    rowHeight: 24, height: 240, overscan: 3, scrollTop: autoScroll, viewport: autoViewport, autoSize: true,
  }), "id", "auto-list");
  autoRoot = attr(attr(el("div", [list]), "id", "auto-wrapper"), "style", "height:360px");
  mountTo(autoRoot); flush(); return 0;
}
export function setAutoHeight(height: number): number { attr(autoRoot, "style", "height:" + height + "px"); flush(); return 0; }
export function scrollAuto(index: number): number { return scrollToIndex(autoScroll, index, 10000, 24, autoViewport.get(), "start"); }
export function disposeAuto(): number { unmount(autoRoot); flush(); return 0; }

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
