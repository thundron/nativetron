import { mount, run } from "../framework/dom.js";
import { el, txt, dyn, attr, on, mountTo, each, type El, type KeyedItem } from "../framework/ui.js";
import { signal } from "../framework/reactive.js";

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
        out.push({ key: cur[i]!, el: el("li", [txt(cur[i]!)]) });
      }
      return out;
    }),
    el("p", [dyn(() => `${items.get().length} items`)]),
  ]);
}

mount("nativetron", 560, 520);
mountTo(el("main", [
  el("h1", [txt("nativetron")]),
  el("p", [txt("Same components as the browser build — compiled to native.")]),
  Counter(),
  List(),
]));
run();
