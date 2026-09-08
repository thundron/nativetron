import { mount, run } from "../../framework/dom.js";
import { attr, dyn, el, mountTo, on, txt } from "../../framework/ui.js";
import { signal } from "../../framework/reactive.js";
import { IpcRenderer } from "../../ipc/renderer.js";

const started = +(process.env.NT_BENCH_START_MS ?? "0");
if (started > 0) console.log("NT_BENCH_PHASE=renderer-entry:" + (Date.now() - started));

function phase(name: string): void {
  if (started > 0) console.log("NT_BENCH_PHASE=" + name + ":" + (Date.now() - started));
}

const count = signal(0);
mount("nativetron-bench", 520, 360);
phase("webview-created");
mountTo(el("main", [
  el("h1", [txt("Hello")]),
  el("p", [txt("The counter below is state held in the compiled renderer.")]),
  on(attr(el("button", [txt("Increment")]), "style", "font-size:15px;padding:8px 14px"), "click", () => {
    count.set(count.get() + 1);
  }),
  el("p", [dyn(() => "count: " + count.get())]),
]));
phase("ui-buffered");

const ipc = new IpcRenderer();
ipc.connect(+(process.env.NT_IPC_PORT ?? "0"), "127.0.0.1");
phase("run-enter");
run();
