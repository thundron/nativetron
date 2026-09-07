import { realpathSync, statSync } from "node:fs";
import { posix } from "node:path";

export const ALLOWED_ENVIRONMENT_KEYS = [
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR",
  "ComSpec", "COMSPEC",
];

export function sanitizedPath(value: string | undefined): string {
  if (value === undefined) return "";
  const directories: string[] = [];
  const seen = new Set<string>();
  const entries = value.split(":");
  for (let i = 0; i < entries.length; i++) {
    let entry = entries[i]!.trim();
    if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"'))
      entry = entry.slice(1, -1);
    if (entry.length === 0 || entry.includes("\0") || !posix.isAbsolute(entry)) continue;
    try {
      const canonical = realpathSync(entry);
      if (!statSync(canonical).isDirectory() || seen.has(canonical)) continue;
      seen.add(canonical);
      directories.push(canonical);
    } catch (_error) {
    }
  }
  return directories.join(":");
}

export function sanitizedEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (let i = 0; i < ALLOWED_ENVIRONMENT_KEYS.length; i++) {
    const name = ALLOWED_ENVIRONMENT_KEYS[i]!;
    const value = source[name];
    if (value !== undefined && value.length <= 32768 && !value.includes("\0"))
      environment[name] = value;
  }
  environment["PATH"] = sanitizedPath(source["PATH"]);
  return environment;
}
