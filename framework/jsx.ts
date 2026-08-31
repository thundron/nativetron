import { el, txt, dyn, attr, on, type El } from "./ui.js";

export type Child = El | string | (() => string);
export type PropValue = string | (() => void);

export function h(tag: string | (() => El), props: Record<string, PropValue> | null, ...children: Child[]): El {
  if (typeof tag === "function") return tag();
  const kids: El[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (typeof c === "string") kids.push(txt(c));
    else if (typeof c === "function") kids.push(dyn(c));
    else kids.push(c);
  }
  let e = el(tag, kids);
  if (props === null) return e;
  const names = Object.keys(props);
  for (let i = 0; i < names.length; i++) {
    const k = names[i]!;
    const v = props[k]!;
    if (typeof v === "function") e = on(e, eventName(k), v);
    else e = attr(e, k, v);
  }
  return e;
}

function eventName(k: string): string {
  return k.startsWith("on") ? k.slice(2).toLowerCase() : k;
}
