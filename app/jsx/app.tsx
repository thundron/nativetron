import { mount, run, selftestEval } from "../../framework/dom.js";
import { h, applyProps } from "../../framework/jsx.js";
import { mountTo, each, show, dynAttr, nothing, frag, type El, type KeyedItem, type ElementHandle } from "../../framework/ui.js";
import { useState, useRef, createRef, useImperativeHandle, createContext, useContext, provide, type Ref } from "../../compat/react.js";

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

const Theme = createContext("default");

interface ContextTextProps {
  className: string;
}

function ContextText(props: ContextTextProps): El {
  const theme = useContext(Theme);
  return <p class={props.className}>{theme()}</p>;
}

function ContextDemo(): El {
  const [theme, setTheme] = useState("dark");
  return (
    <section class="context-demo">
      <ContextText className="context-default" />
      <Theme.Provider value={theme()}>
        <ContextText className="context-value" />
        <Theme.Provider value="nested">
          <ContextText className="context-nested" />
        </Theme.Provider>
        <ContextText className="context-after-nested" />
      </Theme.Provider>
      <ContextText className="context-default-after" />
      <button onclick={() => setTheme("light")}>Change context</button>
    </section>
  );
}

interface DemoHandle {
  read: () => string;
}

interface RefChildProps {
  ref: Ref<DemoHandle | null>;
  label: string;
}

function RefChild(props: RefChildProps): El {
  useImperativeHandle(props.ref, () => ({ read: () => "component:" + props.label }));
  return <span>ref child</span>;
}

function RefDemo(): El {
  const hostRef = useRef<ElementHandle | null>(null);
  const componentRef = createRef<DemoHandle>();
  const [hostStatus, setHostStatus] = useState("host:pending");
  const [componentStatus, setComponentStatus] = useState("component:pending");
  return (
    <section class="ref-demo">
      <button ref={hostRef} onclick={() => {
        const handle = hostRef.current;
        setHostStatus(handle === null ? "host:missing" : "host:" + handle.id);
      }}>Read host ref</button>
      <RefChild ref={componentRef} label="ready" />
      <button onclick={() => {
        const handle = componentRef.current;
        setComponentStatus(handle === null ? "component:missing" : handle.read());
      }}>Read component ref</button>
      <p class="host-ref-status">{hostStatus()}</p>
      <p class="component-ref-status">{componentStatus()}</p>
    </section>
  );
}

interface BadgeProps {
  text: string;
}

function Badge(props: BadgeProps): El {
  return <i>{props.text}</i>;
}

function GeneralChildren(): El {
  const stored: El = <b>stored</b>;
  return (
    <section class="general-children">
      {stored}
      {Badge({ text: "called" })}
      {<em>inline</em>}
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
    <ContextDemo />
    <RefDemo />
    <GeneralChildren />
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
        'var context=b.filter(function(x){return x.textContent==="Change context"})[0];' +
        'var hostRef=b.filter(function(x){return x.textContent==="Read host ref"})[0];' +
        'var componentRef=b.filter(function(x){return x.textContent==="Read component ref"})[0];' +
        'inc.click();inc.click();inc.click();spread.click();context.click();hostRef.click();componentRef.click();add.click();rm.click();' +
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
        'spreadTitle:spread.getAttribute("title"),' +
        'generalTags:[].slice.call(document.querySelector(".general-children").children)' +
        '.map(function(x){return x.tagName}).join(","),' +
        'generalText:document.querySelector(".general-children").textContent,' +
        'contextDefault:document.querySelector(".context-default").textContent,' +
        'contextValue:document.querySelector(".context-value").textContent,' +
        'contextNested:document.querySelector(".context-nested").textContent,' +
        'contextAfterNested:document.querySelector(".context-after-nested").textContent,' +
        'contextDefaultAfter:document.querySelector(".context-default-after").textContent,' +
        'contextParent:document.querySelector(".context-value").parentElement.className,' +
        'hostRef:document.querySelector(".host-ref-status").textContent,' +
        'componentRef:document.querySelector(".component-ref-status").textContent})}))},500);',
    );
  }, 300);
}

run();
