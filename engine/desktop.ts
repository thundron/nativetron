import { mountStyled, run, quit } from "../framework/dom.js";
import { setApplicationMenu } from "../framework/menu.js";
import { onEngineMessage, sendEngineMessage } from "../framework/engine.js";
import { encodeEngineMessage, ENGINE_COMMAND, LANE_NATIVE, LANE_ENGINE } from "../ipc/engine.generated.js";
import { join } from "node:path";

declare function ntAssetsConfigure(root: string, entry: string, isolated: number): number;
declare function ntEngineMenuSelftest(): number;

const assets = process.env.NT_ENGINE_ASSETS ?? join(process.cwd(), "build", "engine-assets");
if (ntAssetsConfigure(assets, "engine/page.html", 1) !== 1) throw new Error("engine asset directory missing");
mountStyled("nativetron — in-page GPU reactor", 900, 700, "");
if (!setApplicationMenu([{ label: "Engine", items: [
  { label: "Change clear colour", key: "r", action: () => {
    sendEngineMessage(encodeEngineMessage(ENGINE_COMMAND, LANE_NATIVE, LANE_ENGINE, 1, 1, new Uint8Array(0)));
  } },
  { label: "Quit", key: "q", action: () => quit() },
] }])) throw new Error("engine menu unavailable");

let menuTested = false;
onEngineMessage((message) => {
  const report = Buffer.from(message.payload).toString("utf8");
  console.log(report);
  if (process.env.NT_ENGINE_SELFTEST !== "1") return;
  if (report === "GPU_READBACK_OK 4096" && !menuTested) {
    menuTested = true;
    setTimeout(() => {
      if (ntEngineMenuSelftest() !== 1) { console.log("ENGINE_MENU_FAILED"); quit(); }
    }, 250);
  }
  if (report === "GPU_COLOUR_CHANGED") {
    console.log("ENGINE_DESKTOP_OK");
    quit();
  }
  if (report.startsWith("GPU_ERROR") || report.startsWith("GPU_UNAVAILABLE")) {
    console.log("ENGINE_DESKTOP_UNAVAILABLE");
    quit();
  }
});
if (process.env.NT_ENGINE_SELFTEST === "1") setTimeout(() => { console.log("ENGINE_DESKTOP_TIMEOUT"); quit(); }, 15000);
run();
