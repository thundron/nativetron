// nativetron main process — compiled to NATIVE machine code by scriptc.
// Analogous to Electron's main process: owns lifecycle, spawns the renderer.
// Both this and the renderer are AOT-native; there is no Node/V8 at runtime.
import { spawn } from "node:child_process";

console.log("[main] launching compiled renderer…");
const renderer = spawn("./build/renderer", [], { stdio: "inherit" });

renderer.on("exit", (code: number | null) => {
  console.log(`[main] renderer exited with code ${code ?? 0}`);
});
