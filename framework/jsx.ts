import { el, txt, dyn, attr, on, dynAttr, bindRef, type El, type ElementRef } from "./ui.js";

export type Child = El | string | number | (() => string);
export type PropValue = string | number | boolean | (() => string) | (() => void) | ElementRef;

export function h(
  tag: string | (() => El),
  props: Record<string, PropValue> | null,
  ...children: Child[]
): El {
  if (typeof tag === "function") return tag();
  const kids: El[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (typeof c === "string") kids.push(txt(c));
    else if (typeof c === "number") kids.push(txt("" + c));
    else if (typeof c === "function") kids.push(dyn(c));
    else kids.push(c);
  }
  return applyProps(el(tag, kids), props);
}

export function applyProps(e: El, props: Record<string, PropValue> | null): El {
  if (props === null) return e;
  let out = e;
  const names = Object.keys(props);
  for (let i = 0; i < names.length; i++) {
    const k = names[i]!;
    const v = props[k]!;
    if (typeof v === "object") {
      if (k !== "ref") throw new Error("object-valued host props are not supported");
      out = bindRef(out, v);
    } else if (typeof v === "function") {
      if (k.startsWith("on")) out = on(out, eventName(k), v);
      else out = dynAttr(out, k, v as () => string);
    } else if (typeof v === "string") out = attr(out, k, v);
    else if (typeof v === "number") out = attr(out, k, "" + v);
    else out = attr(out, k, v ? "true" : "false");
  }
  return out;
}

function eventName(k: string): string {
  return k.startsWith("on") ? k.slice(2).toLowerCase() : k;
}
