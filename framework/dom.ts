import { HOST_JS } from "./host-embed.generated.js";
import { dispatch, flush, setBinarySink, setLive, type NtEvent } from "./core.js";

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
        ntEval(
          '(window.__nt_send||window.__nt_ipc)(JSON.stringify({n:0,' +
            't:"__selftest",value:document.getElementById("nt-root").textContent}))',
        );
        return;
      }
      if (process.env.NT_BENCH_QUIT === "1") {
        console.log(`NT_READY_MS=${Date.now() - START_MS}`);
        ntTerminate();
      }
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

export function run(): void {
  ntRun();
}
