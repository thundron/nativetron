import { spawn } from "node:child_process";

console.log("[main] launching compiled renderer…");
const renderer = spawn("./build/renderer", [], { stdio: "inherit" });

renderer.on("exit", (code: number | null) => {
  console.log(`[main] renderer exited with code ${code ?? 0}`);
});
