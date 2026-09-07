import { HOST_JS } from "./host-embed.generated.js";
import "./window.js";
import "./desktop.js";
import "./menu.js";
import "./shortcuts.js";
import "./associations.js";
import { dispatchSlotRich, flush, setBinarySink, setLive, type NtEvent } from "./core.js";
import {
  NATIVE_EVENT_BRIDGE_JS, dispatchNativeEvent, parseNativeEventMessage,
} from "./native-event.generated.js";

declare function ntInit(): void;
declare function ntAddInit(js: string): void;
declare function ntSetTitle(title: string): void;
declare function ntSetSize(w: number, h: number): void;
declare function ntSetHtml(html: string): void;
declare function ntOnMessage(cb: (req: string) => void): void;
declare function ntEval(js: string): void;
declare function ntSendOps(b: Uint8Array): void;
declare function ntRun(): void;
declare function ntTerminate(): void;
declare function ntPump(): number;
declare function ntActivate(): void;

const START_MS = Date.now();
const BENCH_START_MS = +(process.env.NT_BENCH_START_MS ?? "0");
const WEBVIEW_MESSAGE_LIMIT = 65536;
const readyCallbacks: (() => void)[] = [];
let hostReady = false;

interface HostControlMessage {
  n: number;
  t: string;
  value: string;
}

// webview.bind serializes the one JavaScript string argument as a JSON array.
// This fixed outer shape belongs to the webview primitive, not the nativetron
// event ABI; exact arity/type and a byte-scale bound are checked before parsing it.
function webviewMessage(request: string): string | null {
  let input: unknown;
  try { input = JSON.parse(request) as unknown; } catch (_error) { return null; }
  if (!Array.isArray(input) || input.length !== 1) return null;
  const message = input[0] as unknown;
  if (typeof message !== "string" || message.length > WEBVIEW_MESSAGE_LIMIT) return null;
  return message;
}

function controlMessage(raw: string): HostControlMessage | null {
  let input: unknown;
  try { input = JSON.parse(raw) as unknown; } catch (_error) { return null; }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const message = input as Record<string, unknown>;
  const n = message["n"];
  const type = message["t"];
  const value = message["value"];
  const keys = Object.keys(message);
  if (typeof n !== "number" || n !== 0 || typeof type !== "string") return null;
  if (type === "__ready" && keys.length === 2 &&
      Object.hasOwn(message, "n") && Object.hasOwn(message, "t")) {
    return { n, t: type, value: "" };
  }
  if (type === "__selftest" && keys.length === 3 &&
      Object.hasOwn(message, "n") && Object.hasOwn(message, "t") && Object.hasOwn(message, "value") &&
      typeof value === "string" && value.length <= WEBVIEW_MESSAGE_LIMIT) {
    return { n, t: type, value };
  }
  return null;
}

export {
  ROOT, newId, createElement, createText, setText, setAttr, append, on, bindText, flush,
} from "./core.js";
export type { NtEvent } from "./core.js";

/** Run application initialization only after the host can accept binary operations. */
export function onReady(callback: () => void): void {
  if (hostReady) {
    callback();
    return;
  }
  if (readyCallbacks.length >= 32) throw new Error("host ready callback limit reached");
  readyCallbacks.push(callback);
}

export function mount(title: string, w: number, h: number): void {
  mountStyled(title, w, h, "");
}

/** Mount the fixed host document with trusted compile-time CSS, never application markup. */
export function mountStyled(title: string, w: number, h: number, css: string): void {
  if (css.toLowerCase().includes("</style")) throw new Error("style text cannot close the host style element");
  setBinarySink((b: Uint8Array) => {
    ntSendOps(b);
  });
  ntInit();
  ntAddInit(HOST_JS);
  ntAddInit(NATIVE_EVENT_BRIDGE_JS);
  ntSetTitle(title);
  ntSetSize(w, h);
  ntSetHtml(
    `<!doctype html><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>${css}</style><body><div id="nt-root"></div></body>`,
  );
  ntOnMessage((req: string) => {
    const rawMessage = webviewMessage(req);
    if (rawMessage === null) return;
    const event = parseNativeEventMessage(rawMessage);
    if (event !== null) {
      dispatchNativeEvent(event, dispatchSlotRich);
      flush();
      return;
    }
    const message = controlMessage(rawMessage);
    if (message === null) return;
    if (message.t === "__ready") {
      setLive();
      flush();
      hostReady = true;
      const callbacks = readyCallbacks.slice();
      readyCallbacks.splice(0, readyCallbacks.length);
      for (let i = 0; i < callbacks.length; i++) callbacks[i]!();
      flush();
      if (process.env.NT_SELFTEST === "1") {
        selftestRead();
        return;
      }
      if (process.env.NT_SELFTEST === "read-delayed") {
        ntEval(
          'setTimeout(function(){var r=document.getElementById("nt-root");' +
            '(window.__nt_send||window.__nt_ipc)(JSON.stringify({n:0,t:"__selftest",' +
            'value:"children="+r.childNodes.length+" error="+(window.__nt_last_error||"")+' +
            '" text="+r.textContent}))},500)',
        );
        return;
      }
      if (process.env.NT_SELFTEST === "ipcui") {
        ntEval(
          'var b=[].slice.call(document.querySelectorAll("button"))' +
            '.filter(function(x){return x.textContent==="Home dir"})[0];' +
            'b.click();' +
            'setTimeout(function(){(window.__nt_send||window.__nt_ipc)(JSON.stringify(' +
            '{n:0,t:"__selftest",value:document.getElementById("nt-root").textContent}))},900);',
        );
        return;
      }
      if (process.env.NT_SELFTEST === "click") {
        ntEval(
          'var b=[].slice.call(document.querySelectorAll("button"))' +
            '.filter(function(x){return x.textContent==="Increment"})[0];' +
            'b.click();b.click();b.click();' +
            'setTimeout(function(){(window.__nt_send||window.__nt_ipc)(JSON.stringify(' +
            '{n:0,t:"__selftest",value:document.getElementById("nt-root").textContent}))},400);',
        );
        return;
      }
      if (process.env.NT_BENCH_QUIT === "1") {
        const start = BENCH_START_MS > 0 && BENCH_START_MS <= Date.now() ? BENCH_START_MS : START_MS;
        console.log(`NT_READY_MS=${Date.now() - start}`);
        ntTerminate();
      }
      return;
    }
    if (message.t === "__selftest") {
      console.log("NT_SELFTEST_TEXT=" + message.value);
      ntTerminate();
      return;
    }
  });
}

/** Evaluate a probe in the page (test tooling; the app decides what to ask). */
export function selftestEval(js: string): void {
  flush();
  ntEval(js);
}

export function selftestRead(): void {
  flush();
  ntEval(
    '(window.__nt_send||window.__nt_ipc)(JSON.stringify({n:0,' +
      't:"__selftest",value:document.getElementById("nt-root").textContent}))',
  );
}

export function quit(): void {
  ntTerminate();
}

export function run(): void {
  if (process.env.NT_BLOCKING_RUN === "1") {
    ntRun();
    return;
  }
  ntActivate();
  const tick = (): void => {
    if (ntPump() === 1) {
      process.exit(0);
      return;
    }
    setTimeout(tick, 8);
  };
  tick();
}
