import { mount, run, selftestEval } from "../../framework/dom.js";
import { h, applyProps } from "../../framework/jsx.js";
import { mountTo, each, show, dynAttr, nothing, frag, type El, type KeyedItem } from "../../framework/ui.js";
import { useState } from "../../compat/react.js";

interface CounterProps {
  label: string;
  step: number;
}

function Counter(props: CounterProps): El {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h2>{props.label}</h2>
      <button style="margin-right:8px" onclick={() => setCount(count() + props.step)}>Increment</button>
      <p style={count() > 5 ? "color:#b00" : "color:#111"}>count: {count()}</p>
      {count() > 5 ? <p>over five</p> : <p>five or fewer</p>}
      {count() > 8 && <p>and over eight</p>}
    </section>
  );
}

function SpreadAttrs(): El {
  const [tone, setTone] = useState("cold");
  const spread = {
    class: "before",
    "data-order": "spread",
    title: () => "tone:" + tone(),
  };
  return (
    <button {...spread} class="after" data-order="explicit" onclick={() => setTone("hot")}>Spread</button>
  );
}

function Fragmented(): El {
  return (
    <>
      <p class="fragment-a">fragment alpha</p>
      <p class="fragment-b">fragment beta</p>
    </>
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
      <ul class="items">{items().map((x: string) => <li key={x}>{x}</li>)}</ul>
      <p>{items().length} items</p>
    </section>
  );
}

mount("nativetron — JSX", 560, 560);
const counterDefaults: CounterProps = { label: "By one", step: 1 };

mountTo(
  <main>
    <h1>Compiled JSX</h1>
    <Counter {...counterDefaults} label="By three" step={3} />
    <SpreadAttrs />
    <Fragmented />
    <Items />
  </main>,
);
if (process.env.NT_SELFTEST === "jsx") {
  setTimeout(() => {
    selftestEval(
      'var b=[].slice.call(document.querySelectorAll("button"));' +
        'var inc=b.filter(function(x){return x.textContent==="Increment"})[0];' +
        'var add=b.filter(function(x){return x.textContent==="Add"})[0];' +
        'var rm=b.filter(function(x){return x.textContent==="Remove first"})[0];' +
        'var spread=b.filter(function(x){return x.textContent==="Spread"})[0];' +
        'inc.click();inc.click();inc.click();spread.click();add.click();rm.click();' +
        'setTimeout(function(){' +
        'var p=[].slice.call(document.querySelectorAll("p"))' +
        '.filter(function(x){return x.textContent.indexOf("count:")===0})[0];' +
        'var ul=document.querySelector("ul.items");' +
        '(window.__nt_send||window.__nt_ipc)(JSON.stringify({n:0,t:"__selftest",value:' +
        'JSON.stringify({text:document.getElementById("nt-root").textContent,' +
        'countStyle:p.getAttribute("style"),' +
        'items:[].slice.call(ul.children).map(function(li){return li.textContent}).join(","),' +
        'fragmentParent:document.querySelector(".fragment-a").parentElement.tagName,' +
        'fragmentAdjacent:document.querySelector(".fragment-a").nextElementSibling.className,' +
        'spreadClass:spread.getAttribute("class"),' +
        'spreadOrder:spread.getAttribute("data-order"),' +
        'spreadTitle:spread.getAttribute("title")})}))},500);',
    );
  }, 300);
}

run();
