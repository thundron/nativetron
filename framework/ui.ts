import {
  ROOT, newId, createElement, createText, setAttr, append, insertBefore, remove,
  flush, on as listen, unlisten, bindText,
} from "./core.js";
import { effect, beginEffectScope, endEffectScope, type Cleanup } from "./reactive.js";

export interface El {
  roots: number[];
  cleanups: Cleanup[];
}

export interface ElementHandle {
  id: number;
}

export interface ElementRef {
  current: ElementHandle | null;
}

function addCleanup(e: El, cleanup: Cleanup): void {
  e.cleanups.push(cleanup);
}

export function disposeEl(e: El): void {
  const cleanups = e.cleanups;
  e.cleanups = [];
  for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]!();
}

export function bindRef(e: El, ref: ElementRef): El {
  ref.current = { id: e.roots[0]! };
  addCleanup(e, () => { ref.current = null; });
  return e;
}

function takeCleanups(out: Cleanup[], child: El): void {
  for (let i = 0; i < child.cleanups.length; i++) out.push(child.cleanups[i]!);
  child.cleanups = [];
}

function appendEl(parent: number, child: El): void {
  for (let i = 0; i < child.roots.length; i++) append(parent, child.roots[i]!);
}

function removeEl(child: El): void {
  disposeEl(child);
  for (let i = 0; i < child.roots.length; i++) remove(child.roots[i]!);
}

export function el(tag: string, children: El[]): El {
  const id = newId();
  const cleanups: Cleanup[] = [];
  createElement(id, tag);
  for (let i = 0; i < children.length; i++) {
    appendEl(id, children[i]!);
    takeCleanups(cleanups, children[i]!);
  }
  return { roots: [id], cleanups };
}

export function frag(children: El[]): El {
  const roots: number[] = [];
  const cleanups: Cleanup[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    for (let j = 0; j < child.roots.length; j++) roots.push(child.roots[j]!);
    takeCleanups(cleanups, child);
  }
  return { roots, cleanups };
}

export function txt(s: string): El {
  const id = newId();
  createText(id, s);
  return { roots: [id], cleanups: [] };
}

export function dyn(compute: () => string): El {
  const id = newId();
  createText(id, "");
  return { roots: [id], cleanups: [bindText(id, compute)] };
}

export function attr(e: El, name: string, value: string): El {
  setAttr(e.roots[0]!, name, value);
  return e;
}

export function on(e: El, type: string, handler: () => void): El {
  const id = e.roots[0]!;
  listen(id, type, () => { handler(); });
  addCleanup(e, () => { unlisten(id, type); });
  return e;
}

export function component(build: () => El): El {
  beginEffectScope();
  try {
    const out = build();
    addCleanup(out, endEffectScope());
    return out;
  } catch (error) {
    endEffectScope()();
    throw error;
  }
}

export function mountTo(root: El): void {
  appendEl(ROOT, root);
}

export function unmount(root: El): void {
  removeEl(root);
  flush();
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

function insertEl(a: El[], i: number, v: El): El[] {
  const out: El[] = [];
  for (let k = 0; k < i; k++) out.push(a[k]!);
  out.push(v);
  for (let k = i; k < a.length; k++) out.push(a[k]!);
  return out;
}

function discardFresh(fresh: El, retained: El): void {
  if (fresh.roots[0] === retained.roots[0]) return;
  removeEl(fresh);
}

export function each(tag: string, build: () => KeyedItem[]): El {
  const host = newId();
  createElement(host, tag);
  let keys: string[] = [];
  let items: El[] = [];
  let first = true;

  const stop = effect(() => {
    const next = build();
    const nextKeys: string[] = [];
    for (let i = 0; i < next.length; i++) nextKeys.push(next[i]!.key);

    const wanted = new Map<string, number>();
    for (let i = 0; i < nextKeys.length; i++) wanted.set(nextKeys[i]!, i);

    for (let i = keys.length - 1; i >= 0; i--) {
      if (!wanted.has(keys[i]!)) {
        removeEl(items[i]!);
        keys.splice(i, 1);
        items.splice(i, 1);
      }
    }

    const at = new Map<string, number>();
    for (let i = 0; i < keys.length; i++) at.set(keys[i]!, i);

    for (let i = 0; i < nextKeys.length; i++) {
      const key = nextKeys[i]!;
      const fresh = next[i]!.el;
      const cur = at.get(key);
      if (cur === i) {
        discardFresh(fresh, items[i]!);
        continue;
      }

      let item = fresh;
      if (cur !== undefined) {
        item = items[cur]!;
        discardFresh(fresh, item);
        keys.splice(cur, 1);
        items.splice(cur, 1);
      }
      const id = item.roots[0]!;
      if (i < keys.length) insertBefore(host, id, items[i]!.roots[0]!);
      else append(host, id);
      keys = insertStr(keys, i, key);
      items = insertEl(items, i, item);
      for (let j = i; j < keys.length; j++) at.set(keys[j]!, j);
    }

    if (!first) flush();
    first = false;
  });

  const cleanupItems = () => {
    for (let i = items.length - 1; i >= 0; i--) disposeEl(items[i]!);
    items = [];
    keys = [];
  };
  return { roots: [host], cleanups: [cleanupItems, stop] };
}

export function show(cond: () => boolean, whenTrue: () => El, whenFalse: () => El): El {
  const host = newId();
  createElement(host, "span");
  let current: El = { roots: [], cleanups: [] };
  let last = -1;
  let first = true;

  const stop = effect(() => {
    const c = cond() ? 1 : 0;
    if (c === last) return;
    removeEl(current);
    const next = c === 1 ? whenTrue() : whenFalse();
    appendEl(host, next);
    current = next;
    last = c;
    if (!first) flush();
    first = false;
  });

  const cleanupCurrent = () => { disposeEl(current); };
  return { roots: [host], cleanups: [cleanupCurrent, stop] };
}

export function dynAttr(e: El, name: string, compute: () => string): El {
  let first = true;
  const stop = effect(() => {
    setAttr(e.roots[0]!, name, compute());
    if (!first) flush();
    first = false;
  });
  addCleanup(e, stop);
  return e;
}

export function nothing(): El {
  const id = newId();
  createText(id, "");
  return { roots: [id], cleanups: [] };
}
