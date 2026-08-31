import { mount, run } from "../../framework/dom.js";
import { h } from "../../framework/jsx.js";
import { mountTo, type El } from "../../framework/ui.js";
import { useState, useMemo, useEffect } from "../../compat/react.js";

function Counter(): El {
  const [count, setCount] = useState(0);
  const doubled = useMemo(() => count() * 2);

  useEffect(() => {
    console.log("[effect] count is now " + count());
  });

  return (
    <section>
      <h2>Counter</h2>
      <button style="margin-right:8px" onclick={() => setCount(count() + 1)}>Increment</button>
      <p>count: {count()}</p>
      <p>doubled: {doubled()}</p>
    </section>
  );
}

function Items(): El {
  const [items, setItems] = useState<string[]>(["alpha", "beta", "gamma"]);
  return (
    <section>
      <h2>Items</h2>
      <button style="margin-right:8px" onclick={() => {
        const next = items().slice();
        next.push("item-" + (next.length + 1));
        setItems(next);
      }}>Add</button>
      <button onclick={() => { const next = items().slice(); next.shift(); setItems(next); }}>Remove first</button>
      <p>{items().length} items</p>
    </section>
  );
}

mount("nativetron — React-style, compiled", 560, 480);
mountTo(
  <main>
    <h1>useState, compiled</h1>
    <p style="color:#666">No React runtime. No virtual DOM. No JS engine.</p>
    <Counter />
    <Items />
  </main>,
);
run();
