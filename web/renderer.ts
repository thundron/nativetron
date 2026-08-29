import {
  ROOT, newId, createElement, createText, setAttr, append, on, bindText,
  flush, setSink, setLive, dispatch, type NtEvent,
} from "../framework/core.js";
import { signal } from "../framework/reactive.js";

declare function ntApply(batch: string): void;

const count = signal(0);

export function start(): number {
  setSink((json: string) => { ntApply(json); });

  const h1 = newId();
  createElement(h1, "h1");
  const h1t = newId();
  createText(h1t, "Hello from nativetron (wasm)");
  append(h1, h1t);
  append(ROOT, h1);

  const p = newId();
  createElement(p, "p");
  const pt = newId();
  createText(pt, "This UI is driven by TypeScript compiled to WebAssembly.");
  append(p, pt);
  append(ROOT, p);

  const btn = newId();
  createElement(btn, "button");
  setAttr(btn, "style", "font-size:15px;padding:8px 14px");
  const btnLabel = newId();
  createText(btnLabel, "Increment");
  append(btn, btnLabel);
  append(ROOT, btn);

  const out = newId();
  createElement(out, "p");
  const outText = newId();
  createText(outText, "count: 0");
  append(out, outText);
  append(ROOT, out);

  bindText(outText, () => `count: ${count.get()}`);
  on(btn, "click", () => { count.set(count.get() + 1); });

  setLive();
  flush();
  return 0;
}

export function onEvent(json: string): number {
  const ev = JSON.parse(json) as NtEvent;
  dispatch(ev);
  flush();
  return 0;
}
