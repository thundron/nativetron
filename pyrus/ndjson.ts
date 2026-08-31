import { TextDecoder } from "node:util";

export interface NDJSONLimits {
  maxLineBytes: number;
  maxObjectBytes: number;
  maxEvents: number;
  maxTotalBytes: number;
}

export const DEFAULT_NDJSON_LIMITS: NDJSONLimits = {
  maxLineBytes: 1024 * 1024,
  maxObjectBytes: 64 * 1024,
  maxEvents: 250000,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface PearErrorData {
  message?: string;
  code?: string;
}

export type PearEventData = Record<string, unknown> | string | number | boolean | null;

export interface PearEventDiagnostic {
  type: string;
  cmd: string;
  tag: string;
}

export interface PearEvent {
  cmd: string;
  tag: string;
  data: PearEventData;
  known: boolean;
  diagnostic?: PearEventDiagnostic;
}

export class PearNDJSONError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PearNDJSONError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PearNDJSONError(code, message);
}

function identity(value: string, label: string): string {
  if (value.length === 0 || value.length > 128 || /[\0-\x1f\x7f]/u.test(value)) {
    fail("NDJSON_EVENT_SHAPE", label + " must be a bounded non-empty string");
  }
  return value;
}

function commonTag(tag: string): boolean {
  return tag === "final" || tag === "error" || tag === "progress" || tag === "data";
}

function includes(tag: string, values: string[]): boolean {
  for (let i = 0; i < values.length; i++) if (values[i] === tag) return true;
  return false;
}

function knownTag(cmd: string, tag: string): boolean {
  if (commonTag(tag)) return true;
  if (cmd === "touch") return includes(tag, ["link", "key"]);
  if (cmd === "stage" || cmd === "provision")
    return includes(tag, ["staging", "provisioning", "provisioned", "file", "add", "addition", "change", "changed", "delete", "deletion", "link"]);
  if (cmd === "build") return includes(tag, ["building", "artifact", "complete", "file"]);
  if (cmd === "seed")
    return includes(tag, ["seeding", "peer", "peer-add", "peer-join", "peer-remove", "peer-drop", "peer-sync", "sync", "stats", "stat", "availability", "announced", "link"]);
  if (cmd === "info") return includes(tag, ["info", "metadata", "manifest", "multisig", "link", "key", "keys"]);
  if (cmd === "dump") return includes(tag, ["dumping", "file", "entry"]);
  if (cmd === "install") return includes(tag, ["installing", "installed", "file"]);
  if (cmd === "changelog") return includes(tag, ["entry", "changelog"]);
  if (cmd === "cores" || cmd === "gc") return tag === "core";
  if (cmd === "versions") return includes(tag, ["version", "platform", "runtimes", "libraries", "modules"]);
  if (cmd === "multisig")
    return includes(tag, ["multisig", "multisigging", "request", "verified", "commit", "committed", "key", "keys", "getting-src-blobs", "verify-db-requestable-start", "getting-blobs-length", "verify-blobs-requestable-start", "creating-drive", "verify-committable-start", "commit-start", "verify-committed-start"]);
  return false;
}

function validateDepth(value: unknown, depth: number): void {
  if (value === null || typeof value !== "object") return;
  if (depth > 64)
    fail("NDJSON_OBJECT_DEPTH", "NDJSON object nesting exceeds 64 levels");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  for (let i = 0; i < keys.length; i++) validateDepth(object[keys[i]!], depth + 1);
}

function validateEvent(raw: Record<string, unknown>): PearEvent {
  validateDepth(raw, 0);
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (key !== "cmd" && key !== "tag" && key !== "data")
      fail("NDJSON_EVENT_SHAPE", "NDJSON record." + key + " is not allowed");
  }
  const cmdValue = raw["cmd"];
  const tagValue = raw["tag"];
  if (typeof cmdValue !== "string" || typeof tagValue !== "string")
    fail("NDJSON_EVENT_SHAPE", "NDJSON record cmd and tag must be strings");
  const cmd = identity(cmdValue, "cmd");
  const tag = identity(tagValue, "tag");
  const value = raw["data"];
  let data: PearEventData = null;
  if (value === undefined || value === null) {
    data = null;
  } else if (typeof value === "string") {
    if (value.length > 8192)
      fail("NDJSON_EVENT_SHAPE", "NDJSON record.data string is too large");
    data = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    data = value;
  } else if (typeof value === "object" && !Array.isArray(value)) {
    data = value as Record<string, unknown>;
  } else {
    fail("NDJSON_EVENT_SHAPE", "NDJSON record.data has an unsupported shape");
  }
  if (tag === "error" && data !== null && data !== false && data !== 0 && data !== "") {
    if (typeof data !== "object")
      fail("NDJSON_ERROR_SHAPE", "structured error data.message is invalid");
    const message = data["message"];
    const code = data["code"];
    if (typeof message !== "string" || message.length === 0 || message.length > 8192)
      fail("NDJSON_ERROR_SHAPE", "structured error data.message is invalid");
    if (code !== undefined && (typeof code !== "string" || code.length > 8192))
      fail("NDJSON_ERROR_SHAPE", "structured error data.code is invalid");
  }
  const known = knownTag(cmd, tag);
  if (known) return { cmd, tag, data, known };
  return { cmd, tag, data, known, diagnostic: { type: "unknown-tag", cmd, tag } };
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function newlineAt(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) return i;
  return -1;
}

export class PearNDJSONParser {
  limits: NDJSONLimits;
  pending: Uint8Array;
  totalBytes: number;
  eventCount: number;
  ended: boolean;

  constructor(options: Partial<NDJSONLimits> = {}) {
    const limits: NDJSONLimits = {
      maxLineBytes: options.maxLineBytes ?? DEFAULT_NDJSON_LIMITS.maxLineBytes,
      maxObjectBytes: options.maxObjectBytes ?? DEFAULT_NDJSON_LIMITS.maxObjectBytes,
      maxEvents: options.maxEvents ?? DEFAULT_NDJSON_LIMITS.maxEvents,
      maxTotalBytes: options.maxTotalBytes ?? DEFAULT_NDJSON_LIMITS.maxTotalBytes,
    };
    if (!Number.isSafeInteger(limits.maxLineBytes) || limits.maxLineBytes <= 0 || limits.maxLineBytes > DEFAULT_NDJSON_LIMITS.maxLineBytes
      || !Number.isSafeInteger(limits.maxObjectBytes) || limits.maxObjectBytes <= 0 || limits.maxObjectBytes > DEFAULT_NDJSON_LIMITS.maxObjectBytes
      || !Number.isSafeInteger(limits.maxEvents) || limits.maxEvents <= 0 || limits.maxEvents > DEFAULT_NDJSON_LIMITS.maxEvents
      || !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes <= 0 || limits.maxTotalBytes > DEFAULT_NDJSON_LIMITS.maxTotalBytes) {
      throw new RangeError("NDJSON limits must be positive integers no greater than shared contract limits");
    }
    this.limits = limits;
    this.pending = new Uint8Array(0);
    this.totalBytes = 0;
    this.eventCount = 0;
    this.ended = false;
  }

  feed(chunk: Uint8Array): PearEvent[] {
    if (this.ended) fail("NDJSON_STREAM_ENDED", "cannot feed a completed NDJSON stream");
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.limits.maxTotalBytes)
      fail("NDJSON_TOTAL_LIMIT", "NDJSON stream exceeds the total-byte limit");
    this.pending = appendBytes(this.pending, chunk);
    const events: PearEvent[] = [];
    let newline = newlineAt(this.pending);
    while (newline >= 0) {
      let line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 13) line = line.slice(0, line.length - 1);
      if (line.length > 0) events.push(this.parseLine(line));
      newline = newlineAt(this.pending);
    }
    if (this.pending.length > this.limits.maxLineBytes)
      fail("NDJSON_LINE_LIMIT", "NDJSON line exceeds the line-byte limit");
    return events;
  }

  finish(chunk?: Uint8Array): PearEvent[] {
    const events: PearEvent[] = [];
    if (chunk !== undefined) {
      const fed = this.feed(chunk);
      for (let i = 0; i < fed.length; i++) events.push(fed[i]!);
    }
    if (this.ended) fail("NDJSON_STREAM_ENDED", "NDJSON stream is already completed");
    this.ended = true;
    if (this.pending.length > 0) events.push(this.parseLine(this.pending));
    this.pending = new Uint8Array(0);
    return events;
  }

  resetWindow(): boolean {
    if (this.pending.length !== 0 || this.ended) return false;
    this.totalBytes = 0;
    this.eventCount = 0;
    return true;
  }

  parseLine(line: Uint8Array): PearEvent {
    if (line.length > this.limits.maxLineBytes)
      fail("NDJSON_LINE_LIMIT", "NDJSON line exceeds the line-byte limit");
    if (line.length > this.limits.maxObjectBytes)
      fail("NDJSON_OBJECT_LIMIT", "NDJSON object exceeds the event-byte limit");
    this.eventCount++;
    if (this.eventCount > this.limits.maxEvents)
      fail("NDJSON_EVENT_LIMIT", "NDJSON stream exceeds the event-count limit");
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch (_error) {
      fail("NDJSON_UTF8", "NDJSON record is not valid UTF-8 at event " + this.eventCount);
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch (_error) {
      fail("NDJSON_JSON", "NDJSON record is malformed JSON at event " + this.eventCount);
    }
    return validateEvent(raw);
  }
}

export function parseNDJSONChunks(chunks: Uint8Array[]): PearEvent[] {
  const parser = new PearNDJSONParser();
  const events: PearEvent[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const next = parser.feed(chunks[i]!);
    for (let j = 0; j < next.length; j++) events.push(next[j]!);
  }
  const final = parser.finish();
  for (let i = 0; i < final.length; i++) events.push(final[i]!);
  return events;
}

export function summarizeNDJSON(bytes: Uint8Array): string {
  const split = Math.floor(bytes.length / 2);
  const events = parseNDJSONChunks([bytes.slice(0, split), bytes.slice(split)]);
  const lines: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    lines.push(event.cmd + ":" + event.tag + ":" + (event.known ? "known" : "unknown"));
  }
  return lines.join("\n");
}
