import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i < 0 ? fallback : args[i + 1];
};
const has = (flag) => args.includes(flag);
const configPath = path.resolve(value("--config", path.join(here, "nativetron.config.json")));
const configDir = path.dirname(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const output = path.resolve(value("--output", path.join(path.dirname(here), "dist")));
const check = has("--check");

const required = ["name", "executable", "bundleIdentifier", "version", "minimumSystemVersion", "mainBinary", "rendererBinary"];
for (const key of required) {
  if (typeof config[key] !== "string" || config[key].length === 0) throw new Error(`invalid or missing config field: ${key}`);
}
if (/[/:]/.test(config.name)) throw new Error("name must not contain path separators");
if (!/^[A-Za-z0-9._-]+$/.test(config.executable)) throw new Error("executable must be a safe file name");
if (!/^[A-Za-z0-9.-]+$/.test(config.bundleIdentifier) || !config.bundleIdentifier.includes(".")) throw new Error("invalid bundleIdentifier");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(config.version)) throw new Error("version must be SemVer");
const mainBinary = path.resolve(configDir, config.mainBinary);
const rendererBinary = path.resolve(configDir, config.rendererBinary);
for (const binary of [mainBinary, rendererBinary]) if (!existsSync(binary)) throw new Error(`missing binary: ${binary}`);
if (config.icon && !existsSync(path.resolve(configDir, config.icon))) throw new Error(`missing icon: ${config.icon}`);
if (config.entitlements && !existsSync(path.resolve(configDir, config.entitlements))) throw new Error(`missing entitlements: ${config.entitlements}`);

if (check) {
  console.log(`packaging: configuration and binaries valid (${config.bundleIdentifier} ${config.version})`);
  process.exit(0);
}

const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const plistArray = (values) => `<array>${values.map((x) => `<string>${xml(x)}</string>`).join("")}</array>`;
const documentTypes = (config.documentTypes ?? []).map((type) => {
  if (!type.name || !Array.isArray(type.extensions) || type.extensions.length === 0) throw new Error("invalid documentTypes entry");
  return `<dict><key>CFBundleTypeName</key><string>${xml(type.name)}</string><key>CFBundleTypeRole</key><string>${xml(type.role ?? "Viewer")}</string><key>CFBundleTypeExtensions</key>${plistArray(type.extensions)}</dict>`;
}).join("");
const urlTypes = (config.urlSchemes ?? []).map((entry) => {
  if (!entry.name || !Array.isArray(entry.schemes) || entry.schemes.length === 0) throw new Error("invalid urlSchemes entry");
  return `<dict><key>CFBundleURLName</key><string>${xml(entry.name)}</string><key>CFBundleURLSchemes</key>${plistArray(entry.schemes)}</dict>`;
}).join("");

mkdirSync(output, { recursive: true });
const app = path.join(output, `${config.name}.app`);
rmSync(app, { recursive: true, force: true });
const contents = path.join(app, "Contents");
const macos = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
copyFileSync(mainBinary, path.join(resources, "main"));
copyFileSync(rendererBinary, path.join(resources, "renderer"));
chmodSync(path.join(resources, "main"), 0o755);
chmodSync(path.join(resources, "renderer"), 0o755);
if (config.icon) copyFileSync(path.resolve(configDir, config.icon), path.join(resources, "AppIcon.icns"));
if (config.resources) {
  for (const resource of config.resources) cpSync(path.resolve(configDir, resource), path.join(resources, path.basename(resource)), { recursive: true });
}
const launcher = `#!/bin/sh\nCONTENTS=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport NT_RENDERER_PATH="$CONTENTS/Resources/renderer"\ncd "$CONTENTS/Resources"\nexec "$CONTENTS/Resources/main" "$@"\n`;
writeFileSync(path.join(macos, config.executable), launcher, { mode: 0o755 });
writeFileSync(path.join(contents, "PkgInfo"), "APPL????");
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleDevelopmentRegion</key><string>en</string>\n<key>CFBundleDisplayName</key><string>${xml(config.name)}</string>\n<key>CFBundleExecutable</key><string>${xml(config.executable)}</string>\n<key>CFBundleIdentifier</key><string>${xml(config.bundleIdentifier)}</string>\n<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>\n<key>CFBundleName</key><string>${xml(config.name)}</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>${xml(config.version)}</string>\n<key>CFBundleVersion</key><string>${xml(config.buildVersion ?? config.version)}</string>\n<key>LSMinimumSystemVersion</key><string>${xml(config.minimumSystemVersion)}</string>\n${config.category ? `<key>LSApplicationCategoryType</key><string>${xml(config.category)}</string>` : ""}\n${config.icon ? "<key>CFBundleIconFile</key><string>AppIcon</string>" : ""}\n${documentTypes ? `<key>CFBundleDocumentTypes</key><array>${documentTypes}</array>` : ""}\n${urlTypes ? `<key>CFBundleURLTypes</key><array>${urlTypes}</array>` : ""}\n<key>NSHighResolutionCapable</key><true/>\n</dict></plist>\n`;
writeFileSync(path.join(contents, "Info.plist"), plist);

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
};
const identity = value("--sign");
if (identity) {
  const entitlementArgs = config.entitlements ? ["--entitlements", path.resolve(configDir, config.entitlements)] : [];
  const base = ["--force", "--sign", identity];
  if (identity !== "-") base.push("--options", "runtime", "--timestamp");
  run("codesign", [...base, ...entitlementArgs, path.join(resources, "renderer")]);
  run("codesign", [...base, ...entitlementArgs, path.join(resources, "main")]);
  run("codesign", [...base, ...entitlementArgs, app]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
}

let archive = null;
if (!has("--no-archive")) {
  archive = path.join(output, `${config.name}-${config.version}-macos-arm64.zip`);
  rmSync(archive, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
}
const notaryProfile = value("--notary-profile");
if (notaryProfile) {
  if (!identity || identity === "-") throw new Error("notarization requires a Developer ID signing identity");
  if (!archive) throw new Error("notarization requires archive output");
  run("xcrun", ["notarytool", "submit", archive, "--keychain-profile", notaryProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", app]);
  rmSync(archive, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
}
if (has("--dmg")) {
  const dmg = path.join(output, `${config.name}-${config.version}-macos-arm64.dmg`);
  rmSync(dmg, { force: true });
  run("hdiutil", ["create", "-volname", config.name, "-srcfolder", app, "-ov", "-format", "UDZO", dmg]);
}
console.log(`packaging: ${app}${archive ? `\narchive: ${archive}` : ""}`);
