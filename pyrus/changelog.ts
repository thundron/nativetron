import { createHash } from "node:crypto";

const SEMVER = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?";
const HEADING = new RegExp(`^#{1,3}\\s+(?:\\[)?v?(${SEMVER})(?:\\])?(?:\\s+-\\s+.+)?\\s*$`, "u");

export interface ChangelogError {
  line: number;
  reason: string;
}

export interface ChangelogStatus {
  exists: boolean;
  valid: boolean;
  versions: string[];
  errors: ChangelogError[];
  contentHash: string | null;
  currentVersion: string | null;
  currentVersionPresent: boolean;
}

export function changelogStatus(text: string | null, packageVersion: string | null): ChangelogStatus {
  if (text === null) {
    return {
      exists: false,
      valid: false,
      versions: [],
      errors: [],
      contentHash: null,
      currentVersion: packageVersion,
      currentVersionPresent: false,
    };
  }
  const versions: string[] = [];
  const errors: ChangelogError[] = [];
  const seen = new Set<string>();
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!/^#{1,3}\s/u.test(line)) continue;
    const match = line.match(HEADING);
    if (match === null) {
      if (/\d+\.\d+/u.test(line)) errors.push({ line: index + 1, reason: "invalid SemVer heading" });
      continue;
    }
    const version = match[1]!;
    if (seen.has(version)) errors.push({ line: index + 1, reason: "duplicate version heading" });
    else {
      seen.add(version);
      versions.push(version);
    }
  }
  return {
    exists: true,
    valid: errors.length === 0 && versions.length > 0,
    versions,
    errors,
    contentHash: createHash("sha256").update(text).digest("hex"),
    currentVersion: packageVersion,
    currentVersionPresent: packageVersion !== null && versions.includes(packageVersion),
  };
}
