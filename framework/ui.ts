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

    const wanted = new Map<string, number>();
    for (let i = 0; i < nextKeys.length; i++) wanted.set(nextKeys[i]!, i);

    for (let i = keys.length - 1; i >= 0; i--) {
      if (!wanted.has(keys[i]!)) {
        remove(ids[i]!);
        keys.splice(i, 1);
        ids.splice(i, 1);
      }
    }

    const at = new Map<string, number>();
    for (let i = 0; i < keys.length; i++) at.set(keys[i]!, i);

    for (let i = 0; i < nextKeys.length; i++) {
      const k = nextKeys[i]!;
      const cur = at.get(k);
      if (cur === i) continue;
      const id = cur === undefined ? nextIds[i]! : ids[cur]!;
      if (cur !== undefined) {
        keys.splice(cur, 1);
        ids.splice(cur, 1);
      }
      if (i < keys.length) insertBefore(host, id, ids[i]!);
      else append(host, id);
      keys = insertStr(keys, i, k);
      ids = insertNum(ids, i, id);
      for (let j = i; j < keys.length; j++) at.set(keys[j]!, j);
    }

    if (!first) flush();
    first = false;
  });

  return { id: host };
}

/** A subtree chosen by a condition. The wrapper element exists because the
 * protocol addresses nodes by id: swapping needs a stable parent. */
export function show(cond: () => boolean, whenTrue: () => El, whenFalse: () => El): El {
  const host = newId();
  createElement(host, "span");
  let curId = 0;
  let last = -1;
  let first = true;

  effect(() => {
    const c = cond() ? 1 : 0;
    if (c === last) return;
    if (curId !== 0) remove(curId);
    const next = c === 1 ? whenTrue() : whenFalse();
    append(host, next.id);
    curId = next.id;
    last = c;
    if (!first) flush();
    first = false;
  });

  return { id: host };
}

/** An attribute recomputed when its reads change. */
export function dynAttr(e: El, name: string, compute: () => string): El {
  let first = true;
  effect(() => {
    setAttr(e.id, name, compute());
    if (!first) flush();
    first = false;
  });
  return e;
}

/** An empty placeholder, for the false arm of `show`. */
export function nothing(): El {
  const id = newId();
  createText(id, "");
  return { id };
}
