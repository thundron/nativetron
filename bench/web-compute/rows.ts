import {
  ROOT, newId, createElement, createText, setText, append, flush, setBinarySink, setLive,
} from "../../framework/core.js";

declare function ntApply(b: Uint8Array): void;

const labels: string[] = [];
const vals: number[] = [];
const textIds: number[] = [];
const idx: number[] = [];

export function build(n: number): number {
  setBinarySink((b: Uint8Array) => { ntApply(b); });
  for (let i = 0; i < n; i++) {
    labels.push("row " + i);
    vals.push((i * 7919) % 100000);
    idx.push(i);
    const d = newId();
    createElement(d, "div");
    const t = newId();
    createText(t, labels[i]! + " " + vals[i]!);
    append(d, t);
    append(ROOT, d);
    textIds.push(t);
  }
  setLive();
  flush();
  return n;
}

export function update(): number {
  const n = vals.length;
  for (let i = 0; i < n; i++) vals[i] = (vals[i]! * 31 + 7) % 100000;
  idx.sort((a, b) => vals[a]! - vals[b]!);
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    setText(textIds[k]!, labels[i]! + " " + vals[i]!);
  }
  flush();
  return n;
}
