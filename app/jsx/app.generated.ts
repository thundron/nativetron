// generated from app.tsx — do not edit
import { mount, run } from "../../framework/dom.js";
import { h } from "../../framework/jsx.js";
import { mountTo } from "../../framework/ui.js";
import { signal } from "../../framework/reactive.js";
const count = signal(0);
const items = signal(["alpha", "beta", "gamma"]);
function Counter() {
    return (h("section", null,
        h("h2", null, "Counter"),
        h("button", { style: "margin-right:8px", onclick: () => count.set(count.get() + 1) }, "Increment"),
        h("p", null, () => `count: ${count.get()}`)));
}
function List() {
    return (h("section", null,
        h("h2", null, "List"),
        h("button", { style: "margin-right:8px", onclick: () => {
                const next = items.get().slice();
                next.push("item-" + (next.length + 1));
                items.set(next);
            } }, "Add"),
        h("button", { onclick: () => { const next = items.get().slice(); next.shift(); items.set(next); } }, "Remove first"),
        h("p", null, () => `${items.get().length} items`)));
}
mount("nativetron — JSX", 520, 460);
mountTo(h("main", null,
    h("h1", null, "JSX, compiled to native"),
    h("p", { style: "color:#666" }, "No JS engine. No virtual DOM."),
    h(Counter, null),
    h(List, null)));
run();
