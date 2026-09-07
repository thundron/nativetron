const CONTROL_PATTERN = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

export interface StructuredDataLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxString?: number;
  maxBytes?: number;
  maxArray?: number;
  maxKeys?: number;
}

interface SanitizeState {
  nodes: number;
  bytes: number;
}

export function boundedText(value: unknown, label = "text", maximum = 16 * 1024, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maximum ||
      (!allowEmpty && value.length === 0) || CONTROL_PATTERN.test(value))
    throw new TypeError(label + " is invalid");
  return value;
}

export function sanitizeData(
  value: unknown,
  options: StructuredDataLimits = {},
  state: SanitizeState = { nodes: 0, bytes: 0 },
  depth = 0,
): unknown {
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 2000;
  const maxString = options.maxString ?? 16 * 1024;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxArray = options.maxArray ?? 1000;
  const maxKeys = options.maxKeys ?? 200;
  state.nodes++;
  if (state.nodes > maxNodes || depth > maxDepth)
    throw new RangeError("Structured data exceeds limits");

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Structured data contains a non-finite number");
    return value;
  }
  if (typeof value === "string") {
    const text = boundedText(value, "Structured text", maxString);
    state.bytes += Buffer.byteLength(text, "utf8");
    if (state.bytes > maxBytes) throw new RangeError("Structured data exceeds byte limit");
    return text;
  }
  if (Array.isArray(value)) {
    if (value.length > maxArray) throw new RangeError("Structured array exceeds limit");
    const output: unknown[] = [];
    for (let i = 0; i < value.length; i++)
      output.push(sanitizeData(value[i], options, state, depth + 1));
    return output;
  }
  if (value === undefined) return null;
  if (typeof value !== "object") throw new TypeError("Structured data must contain plain values");

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length > maxKeys) throw new RangeError("Structured object exceeds key limit");
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    boundedText(key, "Structured key", 256, false);
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw new TypeError("Unsafe structured key");
    output[key] = sanitizeData(object[key], options, state, depth + 1);
  }
  return output;
}
