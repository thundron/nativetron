import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !sourceArg.endsWith(".app")) throw new Error("usage: node packaging/install.mjs <application.app> [target directory]");
const source = path.resolve(sourceArg);
if (!existsSync(path.join(source, "Contents", "Info.plist"))) throw new Error(`invalid application bundle: ${source}`);
const targetDir = path.resolve(targetArg ?? "/Applications");
mkdirSync(targetDir, { recursive: true });
const target = path.join(targetDir, path.basename(source));
const staged = `${target}.installing-${process.pid}`;
const backup = `${target}.previous-${process.pid}`;
rmSync(staged, { recursive: true, force: true });
rmSync(backup, { recursive: true, force: true });
cpSync(source, staged, { recursive: true, preserveTimestamps: true });
let movedPrevious = false;
try {
  if (existsSync(target)) {
    renameSync(target, backup);
    movedPrevious = true;
  }
  renameSync(staged, target);
  rmSync(backup, { recursive: true, force: true });
} catch (error) {
  rmSync(staged, { recursive: true, force: true });
  if (movedPrevious && !existsSync(target)) renameSync(backup, target);
  throw error;
}
console.log(`installed: ${target}`);
