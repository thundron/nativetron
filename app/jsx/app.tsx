import { mount, run, selftestRead } from "../../framework/dom.js";
import { h } from "../../framework/jsx.js";
import { mountTo, type El } from "../../framework/ui.js";
import { signal } from "../../framework/reactive.js";

const count = signal(0);
const items = signal<string[]>(["alpha", "beta", "gamma"]);

function Counter(): El {
  return (
    <section>
      <h2>Counter</h2>
      <button style="margin-right:8px" onclick={() => count.set(count.get() + 1)}>Increment</button>
      <p>{() => `count: ${count.get()}`}</p>
    </section>
  );
}

function List(): El {
  return (
    <section>
      <h2>List</h2>
      <button style="margin-right:8px" onclick={() => {
        const next = items.get().slice();
        next.push("item-" + (next.length + 1));
        items.set(next);
      }}>Add</button>
      <button onclick={() => { const next = items.get().slice(); next.shift(); items.set(next); }}>Remove first</button>
      <p>{() => `${items.get().length} items`}</p>
    </section>
  );
}

mount("nativetron — JSX", 520, 460);
mountTo(
  <main>
    <h1>JSX, compiled to native</h1>
    <p style="color:#666">No JS engine. No virtual DOM.</p>
    <Counter />
    <List />
  </main>,
);
run();
