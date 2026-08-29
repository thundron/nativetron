// nativetron reconciler-side client for the DOM Host ABI v0.
// Compiled to native. Emits batched DOM ops to the host and routes events back.
import { HOST_JS } from "./host-embed.generated.js";
import { effect } from "./reactive.js";

// ---- FFI into the native core (see ffi/nativetron.ffi.json) ----------------
declare function ntInit(): void;
declare function ntAddInit(js: string): void;
declare function ntSetTitle(title: string): void;
declare function ntSetSize(w: number, h: number): void;
declare function ntSetHtml(html: string): void;
declare function ntOnMessage(cb: (req: string) => void): void;
declare function ntEval(js: string): void;
declare function ntRun(): void;

// ---- ids -------------------------------------------------------------------
export const ROOT = 0;
let nextId = 1;
export function newId(): number {
  return nextId++;
}

// ---- command batch ---------------------------------------------------------
type Op = Array<number | string>;
let batch: Op[] = [];

export function createElement(id: number, tag: string): void { batch.push([1, id, tag]); }
export function createText(id: number, text: string): void { batch.push([2, id, text]); }
export function setText(id: number, text: string): void { batch.push([3, id, text]); }
export function setAttr(id: number, name: string, value: string): void { batch.push([4, id, name, value]); }
export function append(parent: number, child: number): void { batch.push([6, parent, child]); }
export function listenOp(id: number, type: string): void { batch.push([9, id, type]); }

export function flush(): void {
  if (batch.length === 0) return;
  ntEval(`window.__nt.apply(${JSON.stringify(batch)})`);
  batch = [];
}

// ---- reactive text binding -------------------------------------------------
// Bind a text node's content to a reactive `compute`. Runs an effect that emits
// a SET_TEXT op whenever any signal read inside `compute` changes.
//
// The first run happens synchronously here (during UI construction), so it just
// enqueues the SET_TEXT into the pending batch alongside the other build ops —
// the initial flush is driven by the host's `__ready` message. Later runs (from
// a signal change while the app is live) enqueue a SET_TEXT and flush it right
// away so the DOM updates immediately.
let building = true;
export function bindText(nodeId: number, compute: () => string): void {
  effect(() => {
    setText(nodeId, compute());
    if (!building) flush();
  });
}

// ---- events ----------------------------------------------------------------
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

function lookup(key: string): Handler | undefined {
  for (let i = 0; i < handlerKeys.length; i++) {
    if (handlerKeys[i] === key) return handlerFns[i];
  }
  return undefined;
}

// ---- app lifecycle ---------------------------------------------------------
export function mount(title: string, w: number, h: number): void {
  ntInit();
  ntAddInit(HOST_JS);
  ntSetTitle(title);
  ntSetSize(w, h);
  ntSetHtml(
    `<!doctype html><meta charset="utf-8">` +
      `<body style="font-family:-apple-system,system-ui,sans-serif;margin:32px;color:#111">` +
      `<div id="nt-root"></div></body>`,
  );
  ntOnMessage((req: string) => {
    // webview wraps bound-call args as a JSON array: ["{...}"]
    const args = JSON.parse(req) as string[];
    const ev = JSON.parse(args[0]) as NtEvent;
    if (ev.t === "__ready") {
      building = false; // the app is live: later effect runs flush immediately
      flush(); // send the initial UI once the document is ready
      return;
    }
    const h = lookup(`${ev.n}:${ev.t}`);
    if (h) {
      h(ev);
      flush(); // push any DOM mutations the handler produced
    }
  });
}

export function run(): void {
  ntRun();
}
