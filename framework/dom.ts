import { HOST_JS } from "./host-embed.generated.js";
import "./window.js";
import "./desktop.js";
import "./menu.js";
import { dispatch, dispatchSlot, flush, setBinarySink, setLive, type NtEvent } from "./core.js";

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

export {
  ROOT, newId, createElement, createText, setText, setAttr, append, on, bindText, flush,
} from "./core.js";
export type { NtEvent } from "./core.js";

export function mount(title: string, w: number, h: number): void {
  setBinarySink((b: Uint8Array) => {
    ntSendOps(b);
  });
  ntInit();
  ntAddInit(HOST_JS);
  ntAddInit(
    'window.__nt_event=function(slot,value){' +
      '(window.__nt_send||window.__nt_ipc)(JSON.stringify(' +
      '{n:slot,t:"__slot",value:value}))};',
  );
  ntSetTitle(title);
  ntSetSize(w, h);
  ntSetHtml(
    `<!doctype html><meta charset="utf-8">` +
      `<body style="font-family:-apple-system,system-ui,sans-serif;margin:32px;color:#111">` +
      `<div id="nt-root"></div></body>`,
  );
  ntOnMessage((req: string) => {
    const args = JSON.parse(req) as string[];
    const ev = JSON.parse(args[0]) as NtEvent;
    if (ev.t === "__ready") {
      setLive();
      flush();
      if (process.env.NT_SELFTEST === "1") {
        selftestRead();
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
        console.log(`NT_READY_MS=${Date.now() - START_MS}`);
        ntTerminate();
      }
      return;
    }
    if (ev.t === "__slot") {
      dispatchSlot(ev.n, ev.value ?? "");
      flush();
      return;
    }
    if (ev.t === "__selftest") {
      console.log("NT_SELFTEST_TEXT=" + ev.value);
      ntTerminate();
      return;
    }
    dispatch(ev);
    flush();
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
