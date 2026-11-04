import { dispatchEngineMessage } from "./engine.js";
import { ENGINE_ENVELOPE_LIMIT } from "../ipc/engine-bridge.generated.js";
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
declare function ntSetDocumentCss(css: string): void;
declare function ntLoadDocument(): void;
declare function ntOnMessage(cb: (req: string) => void): void;
declare function ntEval(js: string): void;
declare function ntSendOps(b: Uint8Array): void;
declare function ntRun(): void;
declare function ntTerminate(): void;
declare function ntPump(): number;
declare function ntActivate(): void;

const START_MS = Date.now();
const BENCH_START_MS = +(process.env.NT_BENCH_START_MS ?? "0");
const WEBVIEW_MESSAGE_LIMIT = ENGINE_ENVELOPE_LIMIT + 64;
const readyCallbacks: (() => void)[] = [];
let hostReady = false;
let hostSettled = false;

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
  if ((type === "__ready" || type === "__settled") && keys.length === 2 &&
      Object.hasOwn(message, "n") && Object.hasOwn(message, "t")) {
    return { n, t: type, value: "" };
  }
  if (type === "__paint" && keys.length === 3 &&
      Object.hasOwn(message, "n") && Object.hasOwn(message, "t") && Object.hasOwn(message, "value") &&
      typeof value === "string" && value.length <= 64) {
    return { n, t: type, value };
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
  setBinarySink((b: Uint8Array) => {
    ntSendOps(b);
  });
  ntInit();
  ntAddInit("window.__nt_native=true;");
  if (process.env.NT_BENCH_QUIT === "1" || process.env.NT_BENCH_RUNTIME === "1") {
    ntAddInit("window.__nt_bench=true;");
  }
  ntAddInit(HOST_JS);
  ntAddInit(NATIVE_EVENT_BRIDGE_JS);
  ntSetTitle(title);
  ntSetSize(w, h);
  ntSetDocumentCss(css);
  ntOnMessage((req: string) => {
    const rawMessage = webviewMessage(req);
    if (rawMessage === null) return;
    if (dispatchEngineMessage(rawMessage)) return;
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
      if (process.env.NT_BENCH_QUIT === "1" || process.env.NT_BENCH_RUNTIME === "1") {
        const start = BENCH_START_MS > 0 && BENCH_START_MS <= Date.now() ? BENCH_START_MS : START_MS;
        console.log(`NT_BENCH_PHASE=host-ready:${Date.now() - start}`);
      }
      return;
    }
    if (message.t === "__settled") {
      hostSettled = true;
      return;
    }
    if (message.t === "__paint") {
      const start = BENCH_START_MS > 0 && BENCH_START_MS <= Date.now() ? BENCH_START_MS : START_MS;
      const parts = message.value.split(",");
      if (parts.length !== 4) return;
      const appliedAt = +parts[0]!;
      const firstFrameAt = +parts[1]!;
      const paintAt = +parts[2]!;
      const contentfulPaintAt = +parts[3]!;
      const now = Date.now();
      if (!Number.isInteger(appliedAt) || !Number.isInteger(firstFrameAt) || !Number.isInteger(paintAt) ||
          !Number.isInteger(contentfulPaintAt) || appliedAt < start || firstFrameAt < appliedAt ||
          paintAt < firstFrameAt || paintAt > now + 1000 ||
          (contentfulPaintAt !== 0 && (contentfulPaintAt < appliedAt || contentfulPaintAt > now + 1000))) return;
      console.log(`NT_BENCH_PHASE=ui-applied:${appliedAt - start}`);
      console.log(`NT_BENCH_PHASE=frame-one:${firstFrameAt - start}`);
      if (contentfulPaintAt > 0) console.log(`NT_BENCH_PHASE=contentful-paint:${contentfulPaintAt - start}`);
      console.log(`NT_READY_MS=${paintAt - start}`);
      hostSettled = true;
      if (process.env.NT_BENCH_QUIT === "1") ntTerminate();
      else console.log("NT_RUNTIME_READY=1");
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
  setLive();
  flush();
  ntLoadDocument();
  if (process.env.NT_BLOCKING_RUN === "1") {
    ntRun();
    process.exit(0);
    return;
  }
  ntActivate();
  const fastPumpDeadline = Date.now() + 500;
  const tick = (): void => {
    if (ntPump() === 1) {
      process.exit(0);
      return;
    }
    setTimeout(tick, hostSettled || Date.now() >= fastPumpDeadline ? 8 : 0);
  };
  tick();
}
