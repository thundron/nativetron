import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i < 0 ? fallback : args[i + 1];
};
const output = path.resolve(value("--output", path.join(path.dirname(here), "dist")));
const configPath = path.resolve(value("--config", path.join(here, "nativetron.config.json")));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const prefix = `${config.name}-${config.version}-macos-arm64`;
const result = spawnSync(process.execPath, [path.join(here, "package.mjs"), ...args], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const artifacts = readdirSync(output).filter((name) => name.startsWith(prefix) && (name.endsWith(".zip") || name.endsWith(".dmg"))).sort();
const checksums = artifacts.map((name) => ({
  file: name,
  sha256: createHash("sha256").update(readFileSync(path.join(output, name))).digest("hex"),
}));
writeFileSync(path.join(output, "SHA256SUMS.json"), JSON.stringify({ artifacts: checksums }, null, 2) + "\n");
console.log(`release: wrote ${checksums.length} checksums`);
