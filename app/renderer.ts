// nativetron renderer — compiled to native. The entire UI is built through the
// DOM Host ABI: no page-side app JS, no VDOM, just batched DOM ops emitted from
// compiled code. The click handler runs natively and mutates the DOM over the
// bridge. This is the seed of the compile-time-reactive framework.
import {
  ROOT,
  newId,
  createElement,
  createText,
  setText,
  setAttr,
  append,
  on,
  mount,
  run,
} from "../framework/dom.js";

mount("nativetron", 520, 360);

// build the UI tree (ids allocated by the reconciler)
const h1 = newId();
createElement(h1, "h1");
const h1t = newId();
createText(h1t, "Hello from nativetron");
append(h1, h1t);
append(ROOT, h1);

const p = newId();
createElement(p, "p");
const pt = newId();
createText(pt, "The counter below is state held in native code.");
append(p, pt);
append(ROOT, p);

const btn = newId();
createElement(btn, "button");
setAttr(btn, "style", "font-size:15px;padding:8px 14px");
const btnLabel = newId();
createText(btnLabel, "Increment");
append(btn, btnLabel);
append(ROOT, btn);

const out = newId();
createElement(out, "p");
const outText = newId();
createText(outText, "count: 0");
append(out, outText);
append(ROOT, out);

// native state + event handling
let count = 0;
on(btn, "click", () => {
  count++;
  setText(outText, `count: ${count}`);
});

run();
