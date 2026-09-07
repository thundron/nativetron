// generated from app.tsx by app/jsx/build.mjs — do not edit
import { mount, run, selftestEval } from "../../framework/dom.js";
import { h, applyProps } from "../../framework/jsx.js";
import { mountTo, each, show, dynAttr, nothing, frag, component, type El, type KeyedItem, type ElementHandle } from "../../framework/ui.js";
import { Fragment, StrictMode, createContext, createRef, forwardRef, memo, startTransition, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useRef, useState, useTransition, provide, type Ref } from "../../compat/react.js";
interface CounterProps {
    label: string;
    step: number;
}
function Counter(props: CounterProps): El {
    const [count, setCount] = useState(0);
    return (h("section", null, h("h2", null, () => "" + (props.label)), h("button", { "style": "margin-right:8px", "onclick": () => setCount(count() + props.step) }, "Increment"), h("p", { "style": () => "" + (count() > 5 ? "color:#b00" : "color:#111") }, "count: ", () => "" + (count())), show(() => count() > 5, () => h("p", null, "over five"), () => h("p", null, "five or fewer")), show(() => count() > 8, () => h("p", null, "and over eight"), nothing)));
}
const Theme = createContext("default");
interface ContextTextProps {
    className: string;
}
function ContextText(props: ContextTextProps): El {
    const theme = useContext(Theme);
    return h("p", { "class": () => "" + (props.className) }, () => "" + (theme()));
}
function ContextDemo(): El {
    const [theme, setTheme] = useState("dark");
    return (h("section", { "class": "context-demo" }, component(() => ContextText({ "className": "context-default" })), provide(Theme, () => ({ "value": theme() }).value, () => frag([component(() => ContextText({ "className": "context-value" })), provide(Theme, () => ({ "value": "nested" }).value, () => frag([component(() => ContextText({ "className": "context-nested" }))])), component(() => ContextText({ "className": "context-after-nested" }))])), component(() => ContextText({ "className": "context-default-after" })), h("button", { "onclick": () => setTheme("light") }, "Change context")));
}
interface DemoHandle {
    read: () => string;
}
interface RefChildProps {
    ref: Ref<DemoHandle | null>;
    label: string;
}
function RefChild(props: RefChildProps): El {
    useImperativeHandle(props.ref, () => ({ read: () => "component:" + props.label }), [props.label]);
    return h("span", null, "ref child");
}
function RefDemo(): El {
    const hostRef = useRef<ElementHandle | null>(null);
    const componentRef = createRef<DemoHandle>();
    const [hostStatus, setHostStatus] = useState("host:pending");
    const [componentStatus, setComponentStatus] = useState("component:pending");
    return (h("section", { "class": "ref-demo" }, h("button", { "ref": hostRef, "onclick": () => {
            const handle = hostRef.current;
            setHostStatus(handle === null ? "host:missing" : "host:" + handle.id);
        } }, "Read host ref"), component(() => RefChild({ "ref": componentRef, "label": "ready" })), h("button", { "onclick": () => {
            const handle = componentRef.current;
            setComponentStatus(handle === null ? "component:missing" : handle.read());
        } }, "Read component ref"), h("p", { "class": "host-ref-status" }, () => "" + (hostStatus())), h("p", { "class": "component-ref-status" }, () => "" + (componentStatus()))));
}
interface BadgeProps {
    text: string;
}
function Badge(props: BadgeProps): El {
    return h("i", null, () => "" + (props.text));
}
const MemoBadge = memo(Badge);
interface LegacyRefProps {
    label: string;
    ref: Ref<DemoHandle | null> | null;
}
const LegacyRefChild = forwardRef<DemoHandle, LegacyRefProps>((props: LegacyRefProps, ref: Ref<DemoHandle | null> | null) => {
    useImperativeHandle(ref, () => ({ read: () => "legacy:" + props.label }), [props.label]);
    return h("span", { "class": "legacy-ref-child" }, "legacy ref child");
});
function CompatibilityDemo(): El {
    const idA = useId();
    const idB = useId();
    const deferred = useDeferredValue("deferred-ready");
    const [pending, begin] = useTransition();
    const [transitionState, setTransitionState] = useState("transition-idle");
    const legacyRef = createRef<DemoHandle>();
    const [legacyState, setLegacyState] = useState("legacy:pending");
    useDebugValue(idA);
    useLayoutEffect(() => { }, [idA, pending]);
    useInsertionEffect(() => { }, [deferred]);
    return (h("section", { "class": "compatibility-demo", "data-id-a": () => "" + (idA), "data-id-b": () => "" + (idB) }, component(() => StrictMode({ children: [component(() => Fragment({ children: [component(() => MemoBadge({ "text": deferred })), h("span", { "class": "transition-pending" }, () => "" + (pending ? "pending" : "settled"))] }))] })), component(() => LegacyRefChild({ "ref": legacyRef, "label": "ready" })), h("button", { "onclick": () => begin(() => setTransitionState("transition-done")) }, "Run transition"), h("button", { "onclick": () => startTransition(() => {
            const handle = legacyRef.current;
            setLegacyState(handle === null ? "legacy:missing" : handle.read());
        }) }, "Read legacy ref"), h("p", { "class": "transition-state" }, () => "" + (transitionState())), h("p", { "class": "legacy-ref-state" }, () => "" + (legacyState()))));
}
function GeneralChildren(): El {
    const stored: El = h("b", null, "stored");
    return (h("section", { "class": "general-children" }, stored, Badge({ text: "called" }), h("em", null, "inline")));
}
function SpreadAttrs(): El {
    const [tone, setTone] = useState("cold");
    const spread = {
        class: "before",
        "data-order": "spread",
        title: () => "tone:" + tone(),
    };
    return (h("button", { ...spread, "class": "after", "data-order": "explicit", "onclick": () => setTone("hot") }, "Spread"));
}
function Fragmented(): El {
    return (frag([h("p", { "class": "fragment-a" }, "fragment alpha"), h("p", { "class": "fragment-b" }, "fragment beta")]));
}
let lifecycleRuns = 0;
let lifecycleCleanups = 0;
let updateLifecycleChild = (_value: number): void => { };
const lifecycleRef = createRef<ElementHandle>();
const lifecycleComponentRef = createRef<DemoHandle>();
function LifecycleChild(): El {
    const [value, setValue] = useState(0);
    updateLifecycleChild = setValue;
    useEffect(() => {
        if (value() >= 0)
            lifecycleRuns++;
        return () => { lifecycleCleanups++; };
    }, [value()]);
    useImperativeHandle(lifecycleComponentRef, () => ({ read: () => "lifecycle" }), ["lifecycle"]);
    return h("button", { "class": "lifecycle-child", "ref": lifecycleRef, "onclick": () => { } }, "lifecycle child");
}
function LifecycleDemo(): El {
    const [visible, setVisible] = useState(true);
    const [status, setStatus] = useState("pending");
    return (h("section", { "class": "lifecycle-demo" }, h("button", { "onclick": () => updateLifecycleChild(1) }, "Update lifecycle child"), h("button", { "onclick": () => setVisible(!visible()) }, "Toggle lifecycle child"), h("button", { "onclick": () => {
            const next = "runs:" + lifecycleRuns + " cleanups:" + lifecycleCleanups +
                (lifecycleRef.current === null ? " host:cleared" : " host:set") +
                (lifecycleComponentRef.current === null ? " component:cleared" : " component:set");
            setStatus(status() === "pending" ? next : status() + "|" + next);
        } }, "Read lifecycle state"), show(() => visible(), () => component(() => LifecycleChild()), () => h("span", { "class": "lifecycle-empty" }, "removed")), h("p", { "class": "lifecycle-status" }, () => "" + (status()))));
}
function Items(): El {
    const [items, setItems] = useState<string[]>(["alpha", "beta", "gamma"]);
    return (h("section", null, h("h2", null, "Items"), h("button", { "style": "margin-right:8px", "onclick": () => {
            const next = items().slice();
            next.push("item-" + (next.length + 1));
            setItems(next);
        } }, "Add"), h("button", { "onclick": () => { const next = items().slice(); next.shift(); setItems(next); } }, "Remove first"), applyProps(each("ul", () => items().map((x: string) => ({ key: "" + (x), el: h("li", { "title": () => "" + ("count:" + items().length) }, () => "" + (x)) }))), { "class": "items" }), h("p", null, () => "" + (items().length), " items")));
}
mount("nativetron — JSX", 560, 560);
const counterDefaults: CounterProps = { label: "By one", step: 1 };
mountTo(h("main", null, h("h1", null, "Compiled JSX"), component(() => Counter({ ...counterDefaults, "label": "By three", "step": 3 })), component(() => SpreadAttrs()), component(() => ContextDemo()), component(() => RefDemo()), component(() => CompatibilityDemo()), component(() => GeneralChildren()), component(() => Fragmented()), component(() => LifecycleDemo()), component(() => Items())));
if (process.env.NT_SELFTEST === "jsx") {
    setTimeout(() => {
        selftestEval('var b=[].slice.call(document.querySelectorAll("button"));' +
            'var inc=b.filter(function(x){return x.textContent==="Increment"})[0];' +
            'var add=b.filter(function(x){return x.textContent==="Add"})[0];' +
            'var rm=b.filter(function(x){return x.textContent==="Remove first"})[0];' +
            'var spread=b.filter(function(x){return x.textContent==="Spread"})[0];' +
            'var context=b.filter(function(x){return x.textContent==="Change context"})[0];' +
            'var hostRef=b.filter(function(x){return x.textContent==="Read host ref"})[0];' +
            'var componentRef=b.filter(function(x){return x.textContent==="Read component ref"})[0];' +
            'var transition=b.filter(function(x){return x.textContent==="Run transition"})[0];' +
            'var legacyRef=b.filter(function(x){return x.textContent==="Read legacy ref"})[0];' +
            'var updateLifecycle=b.filter(function(x){return x.textContent==="Update lifecycle child"})[0];' +
            'var toggleLifecycle=b.filter(function(x){return x.textContent==="Toggle lifecycle child"})[0];' +
            'var readLifecycle=b.filter(function(x){return x.textContent==="Read lifecycle state"})[0];' +
            'inc.click();inc.click();inc.click();spread.click();context.click();hostRef.click();componentRef.click();transition.click();legacyRef.click();add.click();rm.click();' +
            'updateLifecycle.click();toggleLifecycle.click();updateLifecycle.click();readLifecycle.click();' +
            'for(var q=0;q<20;q++){toggleLifecycle.click();updateLifecycle.click();toggleLifecycle.click();}' +
            'toggleLifecycle.click();readLifecycle.click();' +
            'setTimeout(function(){' +
            'var p=[].slice.call(document.querySelectorAll("p"))' +
            '.filter(function(x){return x.textContent.indexOf("count:")===0})[0];' +
            'var ul=document.querySelector("ul.items");' +
            '(window.__nt_send||window.__nt_ipc)(JSON.stringify({n:0,t:"__selftest",value:' +
            'JSON.stringify({text:document.getElementById("nt-root").textContent,' +
            'countStyle:p.getAttribute("style"),' +
            'items:[].slice.call(ul.children).map(function(li){return li.textContent}).join(","),' +
            'itemTitles:[].slice.call(ul.children).map(function(li){return li.getAttribute("title")}).join(","),' +
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
            'componentRef:document.querySelector(".component-ref-status").textContent,' +
            'compatIdA:document.querySelector(".compatibility-demo").getAttribute("data-id-a"),' +
            'compatIdB:document.querySelector(".compatibility-demo").getAttribute("data-id-b"),' +
            'compatTags:[].slice.call(document.querySelector(".compatibility-demo").children,0,2)' +
            '.map(function(x){return x.tagName}).join(","),' +
            'transitionPending:document.querySelector(".transition-pending").textContent,' +
            'transitionState:document.querySelector(".transition-state").textContent,' +
            'legacyRef:document.querySelector(".legacy-ref-state").textContent,' +
            'lifecycle:document.querySelector(".lifecycle-status").textContent})}))},500);');
    }, 300);
}
run();
