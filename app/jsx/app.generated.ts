// generated from app.tsx by app/jsx/build.mjs — do not edit
import { mount, run, selftestEval } from "../../framework/dom.js";
import { h, applyProps } from "../../framework/jsx.js";
import { mountTo, each, show, dynAttr, nothing, frag, type El, type KeyedItem } from "../../framework/ui.js";
import { useState, createContext, useContext, provide } from "../../compat/react.js";
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
    return (h("section", { "class": "context-demo" }, ContextText({ "className": "context-default" }), provide(Theme, () => ({ "value": theme() }).value, () => frag([ContextText({ "className": "context-value" }), provide(Theme, () => ({ "value": "nested" }).value, () => frag([ContextText({ "className": "context-nested" })])), ContextText({ "className": "context-after-nested" })])), ContextText({ "className": "context-default-after" }), h("button", { "onclick": () => setTheme("light") }, "Change context")));
}
interface BadgeProps {
    text: string;
}
function Badge(props: BadgeProps): El {
    return h("i", null, () => "" + (props.text));
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
function Items(): El {
    const [items, setItems] = useState<string[]>(["alpha", "beta", "gamma"]);
    return (h("section", null, h("h2", null, "Items"), h("button", { "style": "margin-right:8px", "onclick": () => {
            const next = items().slice();
            next.push("item-" + (next.length + 1));
            setItems(next);
        } }, "Add"), h("button", { "onclick": () => { const next = items().slice(); next.shift(); setItems(next); } }, "Remove first"), applyProps(each("ul", () => items().map((x: string) => ({ key: "" + (x), el: h("li", null, () => "" + (x)) }))), { "class": "items" }), h("p", null, () => "" + (items().length), " items")));
}
mount("nativetron — JSX", 560, 560);
const counterDefaults: CounterProps = { label: "By one", step: 1 };
mountTo(h("main", null, h("h1", null, "Compiled JSX"), Counter({ ...counterDefaults, "label": "By three", "step": 3 }), SpreadAttrs(), ContextDemo(), GeneralChildren(), Fragmented(), Items()));
if (process.env.NT_SELFTEST === "jsx") {
    setTimeout(() => {
        selftestEval('var b=[].slice.call(document.querySelectorAll("button"));' +
            'var inc=b.filter(function(x){return x.textContent==="Increment"})[0];' +
            'var add=b.filter(function(x){return x.textContent==="Add"})[0];' +
            'var rm=b.filter(function(x){return x.textContent==="Remove first"})[0];' +
            'var spread=b.filter(function(x){return x.textContent==="Spread"})[0];' +
            'var context=b.filter(function(x){return x.textContent==="Change context"})[0];' +
            'inc.click();inc.click();inc.click();spread.click();context.click();add.click();rm.click();' +
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
            'contextParent:document.querySelector(".context-value").parentElement.className})}))},500);');
    }, 300);
}
run();
