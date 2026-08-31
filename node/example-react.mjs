import React, { useState } from "react";
import { Window } from "./index.mjs";
import { createRenderer } from "./react.mjs";

const h = React.createElement;
const win = new Window({ title: "React on nativetron", width: 560, height: 460 });
const root = createRenderer(win);

function App() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState(["alpha", "beta", "gamma"]);
  return h("main", null,
    h("h1", null, "React, rendered natively"),
    h("p", { style: { color: "#666" } }, "react-reconciler drives nativetron's op protocol."),
    h("button", { onClick: () => setCount((c) => c + 1), style: { marginRight: 8 } }, "Increment"),
    h("button", { onClick: () => setItems((xs) => [...xs, "item-" + (xs.length + 1)]), style: { marginRight: 8 } }, "Add"),
    h("button", { onClick: () => setItems((xs) => xs.slice(1)) }, "Remove first"),
    h("p", null, "count: " + count),
    h("ul", null, items.map((x) => h("li", { key: x }, x))),
    h("p", null, items.length + " items"),
  );
}

win.onReady = () => {
  root.render(h(App));
  win.flush();
  if (process.env.NT_SELFTEST === "1") {
    setTimeout(() => {
      win.eval('var b=[].slice.call(document.querySelectorAll("button"));' +
        'b[0].click();b[0].click();b[1].click();b[2].click();' +
        'setTimeout(function(){(window.__nt_send||window.__nt_ipc)(JSON.stringify(' +
        '{n:0,t:"__probe",value:document.getElementById("nt-root").textContent}))},400);');
    }, 300);
  }
};

const inner = win._message.bind(win);
win._message = (raw) => {
  try {
    const ev = JSON.parse(JSON.parse(raw)[0]);
    if (ev.t === "__probe") { console.log("REACT_DOM=" + ev.value); win.close(); return; }
  } catch {}
  inner(raw);
};

await win.run();
