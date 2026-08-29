import { flush, setBinarySink, setLive, dispatchSlot } from "../../../framework/core.js";
import { el, txt, dyn, attr, on, mountTo, type El } from "../../../framework/ui.js";
import { signal } from "../../../framework/reactive.js";

declare function ntApply(b: Uint8Array): void;

const count = signal(0);

function App(): El {
  return el("main", [
    el("h1", [txt("Hello from nativetron (wasm)")]),
    el("p", [txt("This UI is driven by TypeScript compiled to WebAssembly.")]),
    on(attr(el("button", [txt("Increment")]), "style", "font-size:15px;padding:8px 14px"),
       "click", () => { count.set(count.get() + 1); }),
    el("p", [dyn(() => `count: ${count.get()}`)]),
  ]);
}

export function start(): number {
  setBinarySink((b: Uint8Array) => { ntApply(b); });
  mountTo(App());
  setLive();
  flush();
  return 0;
}

export function onEvent(slot: number): number { dispatchSlot(slot, ""); flush(); return 0; }
export function onEventValue(slot: number, value: string): number { dispatchSlot(slot, value); flush(); return 0; }
