export type PearLinkKind = "stable" | "versioned" | "path" | "hash";
export type PearLinkBaseKind = "stable" | "versioned";

export interface PearLink {
  canonical: string;
  kind: PearLinkKind;
  baseKind: PearLinkBaseKind;
  key: string;
  fork: number | null;
  length: number | null;
  path: string | null;
  pathSegments: string[];
  hash: string | null;
}

export const MAX_LINK_LENGTH = 4096;
const KEY_PATTERN = /^(?:[ybndrfg8ejkmcpqxot1uwisza345h769]{52}|[0-9a-f]{64})$/u;
const VERSION_PATTERN = /^(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,15})\.([ybndrfg8ejkmcpqxot1uwisza345h769]{52}|[0-9a-f]{64})$/u;
const CONTROL_PATTERN = /[\0-\x1f\x7f]/u;

function invalid(message = "Invalid Pear link"): never {
  throw new TypeError(message);
}

export function validatePearKey(key: unknown, label = "Pear key"): string {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) invalid(label + " is invalid");
  return key;
}

function validatePath(pathname: string): string[] {
  if (pathname.length === 0) return [];
  if (!pathname.startsWith("/") || pathname.endsWith("/") || pathname.includes("\\"))
    invalid("Pear link path is invalid");
  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.length > 64) invalid("Pear link path is too deep");
  const segments: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const rawSegment = rawSegments[i]!;
    if (rawSegment.length === 0 || rawSegment.length > 768 || CONTROL_PATTERN.test(rawSegment))
      invalid("Pear link path segment is invalid");
    let decoded = "";
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch (_error) {
      invalid("Pear link path encoding is invalid");
    }
    if (decoded.length === 0 || decoded === "." || decoded === ".." || decoded.length > 255 ||
        decoded.includes("/") || decoded.includes("\\") || CONTROL_PATTERN.test(decoded))
      invalid("Pear link path segment is unsafe");
    segments.push(decoded);
  }
  return segments;
}

function validateFragment(fragment: string | null): string | null {
  if (fragment === null) return null;
  if (fragment.length === 0 || fragment.length > 512 || CONTROL_PATTERN.test(fragment) || fragment.includes("#"))
    invalid("Pear link hash is invalid");
  let decoded = "";
  try {
    decoded = decodeURIComponent(fragment);
  } catch (_error) {
    invalid("Pear link hash encoding is invalid");
  }
  if (decoded.length === 0 || CONTROL_PATTERN.test(decoded)) invalid("Pear link hash is invalid");
  return decoded;
}

export function parsePearLink(value: unknown): PearLink {
  if (typeof value !== "string" || value.length > MAX_LINK_LENGTH ||
      CONTROL_PATTERN.test(value) || !value.startsWith("pear://")) invalid();
  const remainder = value.slice(7);
  if (remainder.length === 0 || remainder.includes("?") || remainder.includes("@")) invalid();

  const hashIndex = remainder.indexOf("#");
  const beforeHash = hashIndex === -1 ? remainder : remainder.slice(0, hashIndex);
  const rawHash = hashIndex === -1 ? null : remainder.slice(hashIndex + 1);
  const slashIndex = beforeHash.indexOf("/");
  const authority = slashIndex === -1 ? beforeHash : beforeHash.slice(0, slashIndex);
  const pathname = slashIndex === -1 ? "" : beforeHash.slice(slashIndex);
  if (authority.length === 0 || authority.includes(":")) invalid();

  const version = authority.match(VERSION_PATTERN);
  let key = "";
  let fork: number | null = null;
  let length: number | null = null;
  let baseKind: PearLinkBaseKind;
  if (version !== null) {
    fork = Number(version[1]!);
    length = Number(version[2]!);
    if (!Number.isSafeInteger(fork) || !Number.isSafeInteger(length))
      invalid("Pear link version is outside the supported range");
    key = validatePearKey(version[3]!);
    baseKind = "versioned";
  } else {
    key = validatePearKey(authority);
    baseKind = "stable";
  }

  const segments = validatePath(pathname);
  const hash = validateFragment(rawHash);
  const kind: PearLinkKind = hash !== null ? "hash" : segments.length > 0 ? "path" : baseKind;
  return {
    canonical: value,
    kind,
    baseKind,
    key,
    fork,
    length,
    path: segments.length > 0 ? "/" + segments.join("/") : null,
    pathSegments: segments,
    hash,
  };
}

export function isPearLink(value: unknown): boolean {
  try {
    parsePearLink(value);
    return true;
  } catch (_error) {
    return false;
  }
}
