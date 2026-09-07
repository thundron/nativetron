import {
  flush, setBinarySink, setLive, dispatchSlot, dispatchSlotValue, dispatchSlotRich,
} from "../framework/core.js";
import { el, txt, dyn, attr, on, mountTo, each, type El, type KeyedItem } from "../framework/ui.js";
import { signal } from "../framework/reactive.js";

declare function ntApply(b: Uint8Array): void;

const count = signal(0);
const items = signal<string[]>(["alpha", "beta", "gamma"]);
let seq = 0;

function button(label: string, handler: () => void): El {
  return on(attr(el("button", [txt(label)]), "style", "margin-right:8px"), "click", handler);
}

function Counter(): El {
  return el("section", [
    el("h2", [txt("Counter")]),
    button("Increment", () => { count.set(count.get() + 1); }),
    el("p", [dyn(() => `count: ${count.get()}`)]),
  ]);
}

function List(): El {
  return el("section", [
    el("h2", [txt("Keyed list")]),
    button("Add", () => {
      seq++;
      const next = items.get().slice();
      next.push(`item-${seq}`);
      items.set(next);
    }),
    button("Remove first", () => {
      const next = items.get().slice();
      next.shift();
      items.set(next);
    }),
    button("Reverse", () => {
      const cur = items.get();
      const next: string[] = [];
      for (let i = cur.length - 1; i >= 0; i--) next.push(cur[i]!);
      items.set(next);
    }),
    each("ul", () => {
      const out: KeyedItem[] = [];
      const cur = items.get();
      for (let i = 0; i < cur.length; i++) {
        const value = cur[i]!;
        out.push({ key: value, build: () => el("li", [txt(value)]) });
      }
      return out;
    }),
    el("p", [dyn(() => `${items.get().length} items`)]),
  ]);
}

function App(): El {
  return el("main", [
    el("h1", [txt("nativetron")]),
    el("p", [txt("Components, signals and keyed lists — compiled to WebAssembly.")]),
    Counter(),
    List(),
  ]);
}

export function start(): number {
  setBinarySink((b: Uint8Array) => { ntApply(b); });
  mountTo(App());
  setLive();
  flush();
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
): number {
  dispatchSlotRich(slot, value, checked, key, code, modifiers, inputType);
  flush();
  return 0;
}
/* /generated:event-export */
