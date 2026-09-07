import {
  ROOT, newId, createElement, createSvgElement, createText, setAttr, setProp,
  focusElement, append, insertBefore, remove, flush, on as listen, unlisten,
  bindText, type NtEvent,
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

function elementFrom(id: number, children: El[]): El {
  const cleanups: Cleanup[] = [];
  for (let i = 0; i < children.length; i++) {
    appendEl(id, children[i]!);
    takeCleanups(cleanups, children[i]!);
  }
  return { roots: [id], cleanups };
}

export function el(tag: string, children: El[]): El {
  const id = newId();
  createElement(id, tag);
  return elementFrom(id, children);
}

/** Create an element in the SVG namespace through the bounded host opcode. */
export function svgEl(tag: string, children: El[]): El {
  const id = newId();
  createSvgElement(id, tag);
  return elementFrom(id, children);
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

/** Set one of the host's explicitly allowed DOM properties. */
export function prop(e: El, name: string, value: string): El {
  setProp(e.roots[0]!, name, value);
  return e;
}

export function onEvent(e: El, type: string, handler: (event: NtEvent) => void): El {
  const id = e.roots[0]!;
  listen(id, type, handler);
  addCleanup(e, () => { unlisten(id, type); });
  return e;
}

export function on(e: El, type: string, handler: () => void): El {
  return onEvent(e, type, (_event: NtEvent) => { handler(); });
}

/** Queue focus without exposing a general property or script-evaluation escape hatch. */
export function focus(ref: ElementRef): void {
  if (ref.current !== null) focusElement(ref.current.id);
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
  build(): El;
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
    for (let i = 0; i < nextKeys.length; i++) {
      const key = nextKeys[i]!;
      if (wanted.has(key)) throw new Error("duplicate keyed item: " + key);
      wanted.set(key, i);
    }

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
      const cur = at.get(key);
      if (cur === i) continue;

      let item: El;
      if (cur === undefined) item = next[i]!.build();
      else {
        item = items[cur]!;
        keys.splice(cur, 1);
        items.splice(cur, 1);
      }
      const id = item.roots[0]!;
      if (i < keys.length) insertBefore(host, id, items[i]!.roots[0]!);
      else append(host, id);
      keys.splice(i, 0, key);
      items.splice(i, 0, item);
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

/** Replace one lifecycle-scoped subtree when its key changes. */
export function switchEl(tag: string, key: () => string, build: (value: string) => El): El {
  const host = newId();
  createElement(host, tag);
  let current: El = { roots: [], cleanups: [] };
  let last = "\u0000";
  let first = true;

  const stop = effect(() => {
    const value = key();
    if (value === last) return;
    removeEl(current);
    current = build(value);
    appendEl(host, current);
    last = value;
    if (!first) flush();
    first = false;
  });

  const cleanupCurrent = () => { disposeEl(current); };
  return { roots: [host], cleanups: [cleanupCurrent, stop] };
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

export function dynProp(e: El, name: string, compute: () => string): El {
  let first = true;
  const stop = effect(() => {
    setProp(e.roots[0]!, name, compute());
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
