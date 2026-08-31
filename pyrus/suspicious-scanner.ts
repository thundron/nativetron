import { posix } from "node:path";

export const SCAN_MAX_ENTRIES = 10000;
export const SCAN_MAX_FINDINGS = 256;
export const SCAN_MAX_PREVIEW_BYTES = 8192;
export const LARGE_ADDITION_BYTES = 25 * 1024 * 1024;

const SECRET_BASENAME = /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|crt|cer|p7b|p7c|p12|pfx|jks|keystore|mobileprovision)|credentials?(?:\..+)?|secrets?(?:\..+)?)$/iu;
const JUNK_BASENAME = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|.*(?:\.swp|\.swo|~|\.tmp)|\.idea|\.vscode|\.fleet|\.history)$/iu;
const ARCHIVE_BINARY = /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|dmg|exe|dll|so|dylib|node|wasm)$/iu;
const CREDENTIAL_TEXT = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|client[_-]?secret|access[_-]?token|github[_-]?token|aws[_-]?secret[_-]?access[_-]?key|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9_+\/= .-]{8,})/iu;

export interface SemanticDiffEntry {
  path?: string;
  file?: string;
  action?: string;
  type?: string;
  beforeBytes?: number;
  afterBytes?: number;
  bytes?: number;
  preview?: string;
  contentPreview?: string;
}

interface NormalizedEntry {
  path: string;
  action: string;
  beforeBytes: number;
  afterBytes: number;
  preview: string;
}

export interface SuspiciousFinding {
  path: string;
  code: string;
  severity: string;
  message: string;
}

function nonnegative(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizedEntry(entry: SemanticDiffEntry): NormalizedEntry {
  const rawPath = entry.path ?? entry.file ?? "";
  const pathname = rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  const actionValue = (entry.action ?? entry.type ?? "change").toLowerCase();
  const action = /delete|remove|purge/u.test(actionValue)
    ? "delete"
    : /add|create/u.test(actionValue) ? "add" : "change";
  const after = entry.afterBytes !== undefined ? entry.afterBytes : entry.bytes;
  const rawPreview = entry.preview ?? entry.contentPreview ?? "";
  return {
    path: pathname,
    action,
    beforeBytes: nonnegative(entry.beforeBytes),
    afterBytes: nonnegative(after),
    preview: rawPreview.slice(0, SCAN_MAX_PREVIEW_BYTES),
  };
}

export function scanSuspiciousContent(diff: SemanticDiffEntry[]): SuspiciousFinding[] {
  const entries = diff.slice(0, SCAN_MAX_ENTRIES).map(normalizedEntry).sort((a, b) =>
    a.path.localeCompare(b.path) || a.action.localeCompare(b.action));
  const findings: SuspiciousFinding[] = [];
  const add = (entry: NormalizedEntry, code: string, severity: string, message: string): void => {
    if (findings.length < SCAN_MAX_FINDINGS) findings.push({ path: entry.path, code, severity, message });
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const basename = posix.basename(entry.path);
    if (SECRET_BASENAME.test(basename)) add(entry, "secret-file", "high", "Possible secret, private key, certificate, or credential file.");
    if (JUNK_BASENAME.test(basename) || entry.path.split("/").some((part) => JUNK_BASENAME.test(part))) {
      add(entry, "local-state", "medium", "Local OS, editor, or temporary state is included.");
    }
    if (ARCHIVE_BINARY.test(basename)) add(entry, "unexpected-binary", "medium", "Unexpected archive or binary content is included.");
    const segments = entry.path.toLowerCase().split("/");
    let generated = 0;
    for (let j = 0; j < segments.length; j++) {
      if (/^(?:deployment|deploy|dist|build|out|by-arch)$/u.test(segments[j]!)) generated++;
    }
    if (generated > 1) add(entry, "nested-generated-output", "high", "Generated deployment output appears nested inside another generated tree.");
    if (entry.action === "add" && entry.afterBytes > LARGE_ADDITION_BYTES) add(entry, "large-addition", "high", "Unexpectedly large file addition.");
    if (entry.action === "delete") add(entry, "deletion", "high", "Dry-run deletes content, possibly because of ignore or purge behavior.");
    if (entry.preview !== "" && CREDENTIAL_TEXT.test(entry.preview)) {
      add(entry, "credential-pattern", "high", "A bounded text preview contains a credential-like pattern.");
    }
  }
  if (diff.length > SCAN_MAX_ENTRIES) {
    add({ path: "", action: "change", beforeBytes: 0, afterBytes: 0, preview: "" },
      "scan-truncated", "high", "Diff exceeded the deterministic scan entry limit.");
  }
  return findings;
}
