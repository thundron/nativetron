import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "nativetron-package-"));
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const main = path.join(bin, "main");
  const renderer = path.join(bin, "renderer");
  writeFileSync(main, "#!/bin/sh\ntest -x \"$NT_RENDERER_PATH\" || exit 9\nexec \"$NT_RENDERER_PATH\"\n");
  writeFileSync(renderer, "#!/bin/sh\necho NT_PACKAGED_LAUNCH=OK\n");
  chmodSync(main, 0o755);
  chmodSync(renderer, 0o755);
  const config = path.join(tmp, "config.json");
  writeFileSync(config, JSON.stringify({
    name: "Package Test",
    executable: "package-test",
    bundleIdentifier: "dev.nativetron.package-test",
    version: "1.2.3",
    minimumSystemVersion: "13.0",
    mainBinary: main,
    rendererBinary: renderer,
    documentTypes: [{ name: "Test Document", extensions: ["ntest"], role: "Editor" }],
    urlSchemes: [{ name: "Package Test URL", schemes: ["ntest"] }],
  }));
  const dist = path.join(tmp, "dist");
  run(process.execPath, [path.join(here, "package.mjs"), "--config", config, "--output", dist, "--no-archive"]);
  const app = path.join(dist, "Package Test.app");
  const plist = path.join(app, "Contents", "Info.plist");
  assert.ok(existsSync(plist));
  run("plutil", ["-lint", plist]);
  assert.equal(run("plutil", ["-extract", "CFBundleIdentifier", "raw", plist]).trim(), "dev.nativetron.package-test");
  assert.match(readFileSync(plist, "utf8"), /<string>ntest<\/string>/);
  assert.match(run(path.join(app, "Contents", "MacOS", "package-test"), []), /NT_PACKAGED_LAUNCH=OK/);

  const installRoot = path.join(tmp, "Applications");
  run(process.execPath, [path.join(here, "install.mjs"), app, installRoot]);
  const installed = path.join(installRoot, "Package Test.app");
  assert.match(run(path.join(installed, "Contents", "MacOS", "package-test"), []), /NT_PACKAGED_LAUNCH=OK/);
  run(process.execPath, [path.join(here, "install.mjs"), app, installRoot]);
  assert.match(run(path.join(installed, "Contents", "MacOS", "package-test"), []), /NT_PACKAGED_LAUNCH=OK/);

  run(process.execPath, [path.join(here, "release.mjs"), "--config", config, "--output", dist]);
  assert.ok(existsSync(path.join(dist, "Package Test-1.2.3-macos-arm64.zip")));
  const checksums = JSON.parse(readFileSync(path.join(dist, "SHA256SUMS.json"), "utf8"));
  assert.equal(checksums.artifacts.length, 1);
  assert.match(checksums.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  console.log("packaging: bundle, launch, install, archive, and checksum checks passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
