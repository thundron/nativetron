// generated from app.tsx by app/jsx/build.mjs — do not edit
import { mount, run } from "../../framework/dom.js";
import { h } from "../../framework/jsx.js";
import { mountTo } from "../../framework/ui.js";
import { useState, useMemo, useEffect } from "../../compat/react.js";
function Counter() {
    const [count, setCount] = useState(0);
    const doubled = useMemo(() => count() * 2);
    useEffect(() => {
        console.log("[effect] count is now " + count());
    });
    return (h("section", null,
        h("h2", null, "Counter"),
        h("button", { style: "margin-right:8px", onclick: () => setCount(count() + 1) }, "Increment"),
        h("p", null,
            "count: ",
            () => "" + (count())),
        h("p", null,
            "doubled: ",
            () => "" + (doubled()))));
}
function Items() {
    const [items, setItems] = useState(["alpha", "beta", "gamma"]);
    return (h("section", null,
        h("h2", null, "Items"),
        h("button", { style: "margin-right:8px", onclick: () => {
                const next = items().slice();
                next.push("item-" + (next.length + 1));
                setItems(next);
            } }, "Add"),
        h("button", { onclick: () => { const next = items().slice(); next.shift(); setItems(next); } }, "Remove first"),
        h("p", null,
            () => "" + (items().length),
            " items")));
}
mount("nativetron — React-style, compiled", 560, 480);
mountTo(h("main", null,
    h("h1", null, "useState, compiled"),
    h("p", { style: "color:#666" }, "No React runtime. No virtual DOM. No JS engine."),
    h(Counter, null),
    h(Items, null)));
run();
