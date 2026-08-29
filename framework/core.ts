import { effect } from "./reactive.js";

export const ROOT = 0;
let nextId = 1;
export function newId(): number {
  return nextId++;
}

type Op = Array<number | string>;
let batch: Op[] = [];
let building = true;
let sink: (json: string) => void = (_json: string) => {};

export function setSink(fn: (json: string) => void): void {
  sink = fn;
}
export function setLive(): void {
  building = false;
}

export function createElement(id: number, tag: string): void { batch.push([1, id, tag]); }
export function createText(id: number, text: string): void { batch.push([2, id, text]); }
export function setText(id: number, text: string): void { batch.push([3, id, text]); }
export function setAttr(id: number, name: string, value: string): void { batch.push([4, id, name, value]); }
export function append(parent: number, child: number): void { batch.push([6, parent, child]); }
export function listenOp(id: number, type: string): void { batch.push([9, id, type]); }

export function flush(): void {
  if (batch.length === 0) return;
  sink(JSON.stringify(batch));
  batch = [];
}

export function bindText(nodeId: number, compute: () => string): void {
  effect(() => {
    setText(nodeId, compute());
    if (!building) flush();
  });
}

export interface NtEvent {
  n: number;
  t: string;
  value?: string;
}
type Handler = (ev: NtEvent) => void;
const handlerKeys: string[] = [];
const handlerFns: Handler[] = [];

export function on(id: number, type: string, h: Handler): void {
  handlerKeys.push(`${id}:${type}`);
  handlerFns.push(h);
  listenOp(id, type);
}

export function dispatch(ev: NtEvent): void {
  const key = `${ev.n}:${ev.t}`;
  for (let i = 0; i < handlerKeys.length; i++) {
    if (handlerKeys[i] === key) {
      handlerFns[i]!(ev);
      return;
    }
  }
}
