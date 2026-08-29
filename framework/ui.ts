import {
  ROOT, newId, createElement, createText, setText, setAttr, append, insertBefore, remove,
  flush, on as listen, bindText,
} from "./core.js";
import { effect } from "./reactive.js";

export interface El {
  id: number;
}

export function el(tag: string, children: El[]): El {
  const id = newId();
  createElement(id, tag);
  for (let i = 0; i < children.length; i++) append(id, children[i]!.id);
  return { id };
}

export function txt(s: string): El {
  const id = newId();
  createText(id, s);
  return { id };
}

export function dyn(compute: () => string): El {
  const id = newId();
  createText(id, "");
  bindText(id, compute);
  return { id };
}

export function attr(e: El, name: string, value: string): El {
  setAttr(e.id, name, value);
  return e;
}

export function on(e: El, type: string, handler: () => void): El {
  listen(e.id, type, () => { handler(); });
  return e;
}

export function mountTo(root: El): void {
  append(ROOT, root.id);
}

export interface KeyedItem {
  key: string;
  el: El;
}

function insertStr(a: string[], i: number, v: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < i; k++) out.push(a[k]!);
  out.push(v);
  for (let k = i; k < a.length; k++) out.push(a[k]!);
  return out;
}

function insertNum(a: number[], i: number, v: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < i; k++) out.push(a[k]!);
  out.push(v);
  for (let k = i; k < a.length; k++) out.push(a[k]!);
  return out;
}

export function each(tag: string, build: () => KeyedItem[]): El {
  const host = newId();
  createElement(host, tag);
  let keys: string[] = [];
  let ids: number[] = [];
  let first = true;

  effect(() => {
    const next = build();
    const nextKeys: string[] = [];
    const nextIds: number[] = [];
    for (let i = 0; i < next.length; i++) {
      nextKeys.push(next[i]!.key);
      nextIds.push(next[i]!.el.id);
    }

    for (let i = keys.length - 1; i >= 0; i--) {
      let stillThere = false;
      for (let j = 0; j < nextKeys.length; j++) if (nextKeys[j] === keys[i]) stillThere = true;
      if (!stillThere) {
        remove(ids[i]!);
        keys.splice(i, 1);
        ids.splice(i, 1);
      }
    }

    for (let i = 0; i < nextKeys.length; i++) {
      const k = nextKeys[i]!;
      let at = -1;
      for (let j = i; j < keys.length; j++) if (keys[j] === k) at = j;
      if (at === i) continue;
      const id = at >= 0 ? ids[at]! : nextIds[i]!;
      if (at >= 0) { keys.splice(at, 1); ids.splice(at, 1); }
      if (i < keys.length) insertBefore(host, id, ids[i]!);
      else append(host, id);
      keys = insertStr(keys, i, k);
      ids = insertNum(ids, i, id);
    }

    if (!first) flush();
    first = false;
  });

  return { id: host };
}
