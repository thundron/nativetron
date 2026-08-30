import { ROOT, newId, createElement, createText, append, setText, flush, setBinarySink, setLive } from "../../framework/core.js";

declare function binOut(b: Uint8Array): void;

const ids: number[] = [];

export function setup(n: number): number {
  setBinarySink((b: Uint8Array) => { binOut(b); });
  for (let i = 0; i < n; i++) {
    const d = newId();
    createElement(d, "div");
    const t = newId();
    createText(t, "row " + i);
    append(d, t);
    append(ROOT, d);
    ids.push(t);
  }
  setLive();
  flush();
  return n;
}

export function frameBinary(): number {
  setBinarySink((b: Uint8Array) => { binOut(b); });
  for (let i = 0; i < ids.length; i++) setText(ids[i]!, "v " + i);
  flush();
  return ids.length;
}
