const upperSnake = (value) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const lowerSnake = (value) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const FIELD_TYPES = {
  string: {
    ts: "string",
    profile: "string",
    output(field, primary) { return `${field.name}${field.name === primary ? "" : "?"}: string;`; },
    guestCheck(field) { return `${field.name}.length > EVENT_${upperSnake(field.name)}_LIMIT`; },
    callbackCheck(field) {
      return `typeof ${field.name} !== "string" || ${field.name}.length > EVENT_${upperSnake(field.name)}_LIMIT`;
    },
    messageCheck(field) {
      return `typeof message.${field.name} !== "string" || message.${field.name}.length > EVENT_${upperSnake(field.name)}_LIMIT`;
    },
    assignment(field, primary) {
      return field.name === primary ? [] : [`  if (${field.name}.length > 0) out.${field.name} = ${field.name};`];
    },
    bound(field) { return `at most ${field.maximum} UTF-16 code units; default \`${field.default}\``; },
  },
  triBoolean: {
    ts: "number",
    profile: "f64",
    output(field) { return `${field.name}?: boolean;`; },
    guestCheck(field) { return `${field.name} < -1 || ${field.name} > 1 || Math.floor(${field.name}) !== ${field.name}`; },
    callbackCheck(field) {
      return `typeof ${field.name} !== "number" || ${field.name} < -1 || ${field.name} > 1 || Math.floor(${field.name}) !== ${field.name}`;
    },
    messageCheck(field) {
      return `typeof message.${field.name} !== "number" || message.${field.name} < -1 || message.${field.name} > 1 || Math.floor(message.${field.name}) !== message.${field.name}`;
    },
    assignment(field) {
      return [
        `  if (${field.name} === 0) out.${field.name} = false;`,
        `  else if (${field.name} === 1) out.${field.name} = true;`,
      ];
    },
    bound() { return "-1 absent, 0 false, 1 true"; },
  },
  modifierBits: {
    ts: "number",
    profile: "f64",
    output(field) { return `${field.name}?: number;`; },
    guestCheck(field) { return `${field.name} < 0 || ${field.name} > ${field.maximum} || Math.floor(${field.name}) !== ${field.name}`; },
    callbackCheck(field) {
      return `typeof ${field.name} !== "number" || ${field.name} < 0 || ${field.name} > ${field.maximum} || Math.floor(${field.name}) !== ${field.name}`;
    },
    messageCheck(field) {
      return `typeof message.${field.name} !== "number" || message.${field.name} < 0 || message.${field.name} > ${field.maximum} || Math.floor(message.${field.name}) !== message.${field.name}`;
    },
    assignment(field) { return [`  out.${field.name} = ${field.name};`]; },
    bound(field) { return `integer bitset 0–${field.maximum}; default \`${field.default}\``; },
  },
};

const HOST_SOURCES = {
  targetValue: (field) => `target && "value" in target ? boundedText(target.value, EVENT_${upperSnake(field.name)}_LIMIT) : ""`,
  targetChecked: () => "target && typeof target.checked === \"boolean\" ? (target.checked ? 1 : 0) : -1",
  eventKey: (field) => `ev && typeof ev.key === "string" ? boundedText(ev.key, EVENT_${upperSnake(field.name)}_LIMIT) : ""`,
  eventCode: (field) => `ev && typeof ev.code === "string" ? boundedText(ev.code, EVENT_${upperSnake(field.name)}_LIMIT) : ""`,
  eventModifiers: () => "ev ? (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0) : 0",
  eventInputType: (field) => `ev && typeof ev.inputType === "string" ? boundedText(ev.inputType, EVENT_${upperSnake(field.name)}_LIMIT) : ""`,
};

export const tsType = (field) => FIELD_TYPES[field.type].ts;
export const profileType = (field) => FIELD_TYPES[field.type].profile;
export const tierFields = (schema, tier) => {
  if (tier.semantics === "default") return [];
  if (tier.semantics === "primary") return schema.fields.filter((field) => field.name === schema.primaryField);
  return schema.fields;
};
export const tierArguments = (schema, tier) => ["slot", ...tierFields(schema, tier).map((field) => field.name)];
export const callbackArguments = (schema) => tierArguments(schema, schema.dispatch.find((tier) => tier.semantics === "rich"));
const tierDispatchName = (tier) => tier.semantics === "default" ? "dispatchSlot" :
  tier.semantics === "primary" ? "dispatchSlotValue" : "dispatchSlotRich";
const tierDecoderName = (tier) => tier.semantics === "default" ? "decodeDefaultHostEvent" :
  tier.semantics === "primary" ? "decodePrimaryHostEvent" : "decodeHostEvent";
const requiredMessageKeys = (schema) => ["version", "kind", "slot", ...schema.fields.map((field) => field.name)];
const literal = (value) => JSON.stringify(value);

function inlineLimit(expression, field) {
  return field.type === "string"
    ? expression.replace(`EVENT_${upperSnake(field.name)}_LIMIT`, String(field.maximum))
    : expression;
}

function callbackChecks(schema, tier, inlineLimits = false) {
  return [
    "typeof slot !== \"number\" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot",
    ...tierFields(schema, tier).map((field) => {
      const expression = FIELD_TYPES[field.type].callbackCheck(field);
      return inlineLimits ? inlineLimit(expression, field) : expression;
    }),
  ];
}

function messageChecks(schema, inlineLimits = false) {
  return [
    `message.version !== ${schema.nativeMessage.version}`,
    `message.kind !== ${JSON.stringify(schema.nativeMessage.kind)}`,
    "typeof message.slot !== \"number\" || message.slot < 0 || message.slot > 4294967295 || Math.floor(message.slot) !== message.slot",
    ...schema.fields.map((field) => {
      const expression = FIELD_TYPES[field.type].messageCheck(field);
      return inlineLimits ? inlineLimit(expression, field) : expression;
    }),
  ];
}

function localMessageChecks(schema) {
  return messageChecks(schema).map((expression) => expression.replaceAll("message.", ""));
}

function exactMessageCheck(schema, subject) {
  const keys = requiredMessageKeys(schema);
  return [
    `${subject} === null || typeof ${subject} !== "object" || Array.isArray(${subject})`,
    `Object.keys(${subject}).length !== ${keys.length}`,
    ...keys.map((key) => `!Object.hasOwn(${subject}, ${JSON.stringify(key)})`),
  ];
}

function bridgeBody(schema, tier) {
  const args = tierArguments(schema, tier);
  return [
    `  var ${tier.semantics}Bridge = function(${args.join(",")}) {`,
    `    if (arguments.length !== ${args.length} ||`,
    `        ${callbackChecks(schema, tier, true).join(" ||\n        ")}) return false;`,
    "    var api = resolve();",
    `    var callback = api && api[${tier.semantics}Symbol];`,
    "    if (typeof callback !== \"function\") return false;",
    `    callback(${args.join(",")});`,
    "    return true;",
    "  };",
    `  target[${JSON.stringify(tier.callback)}] = ${tier.semantics}Bridge;`,
  ].join("\n");
}

export function eventTable(schema) {
  return [
    "| position | field | type | bound/default |",
    "|---:|---|---|---|",
    "| 0 | slot | callback slot | registered u32 slot |",
    ...schema.fields.map((field, index) =>
      `| ${index + 1} | ${field.name} | ${field.type} | ${FIELD_TYPES[field.type].bound(field)} |`),
  ].join("\n");
}

export function eventTierTable(schema) {
  return [
    "| semantics | browser callback | guest export | fields after slot |",
    "|---|---|---|---|",
    ...schema.dispatch.map((tier) =>
      `| ${tier.semantics} | \`${tier.callback}\` | \`${tier.export}\` | ${tierFields(schema, tier).map((field) => field.name).join(", ") || "—"} |`),
  ].join("\n");
}

export function hostEventConstants(schema) {
  const limits = schema.fields
    .filter((field) => field.type === "string")
    .map((field) => `  var EVENT_${upperSnake(field.name)}_LIMIT = ${field.maximum};`);
  const safe = schema.safeEvents.map((name) => `${name}: 1`).join(", ");
  return [...limits, `  var SAFE_EVENTS = { ${safe} };`].join("\n");
}

export function hostEventProjection(schema) {
  const declarations = schema.fields.map((field) =>
    `    var ${field.name} = ${HOST_SOURCES[field.source](field)};`);
  const defaults = (fields) => fields.map((field) => `${field.name} === ${literal(field.default)}`).join(" && ") || "true";
  const defaultTier = schema.dispatch.find((tier) => tier.semantics === "default");
  const primaryTier = schema.dispatch.find((tier) => tier.semantics === "primary");
  const richTier = schema.dispatch.find((tier) => tier.semantics === "rich");
  const nonPrimary = schema.fields.filter((field) => field.name !== schema.primaryField);
  return [
    "    var target = ev && ev.target;",
    ...declarations,
    `    if (${defaults(schema.fields)}) { window.${defaultTier.callback}(slot); return; }`,
    `    if (${defaults(nonPrimary)}) { window.${primaryTier.callback}(slot, ${schema.primaryField}); return; }`,
    `    window.${richTier.callback}(${tierArguments(schema, richTier).join(", ")});`,
  ].join("\n");
}

function nativeBridgeSource(schema) {
  return schema.dispatch.map((tier) => {
    const args = tierArguments(schema, tier);
    const included = new Set(tierFields(schema, tier).map((field) => field.name));
    const payload = [
      `version:${schema.nativeMessage.version}`,
      `kind:${JSON.stringify(schema.nativeMessage.kind)}`,
      "slot:slot",
      ...schema.fields.map((field) => `${field.name}:${included.has(field.name) ? field.name : literal(field.default)}`),
    ].join(",");
    return [
      `window.${tier.callback}=function(${args.join(",")}){`,
      `if(arguments.length!==${args.length}||${callbackChecks(schema, tier, true).join("||")})return false;`,
      `(window.__nt_send||window.__nt_ipc)(JSON.stringify({${payload}}));`,
      "return true;};",
    ].join("");
  }).join("");
}

function decoder(schema, tier) {
  const fields = tierFields(schema, tier);
  const included = new Set(fields.map((field) => field.name));
  const parameters = fields.map((field) => `${field.name}: ${tsType(field)}`).join(", ");
  const declarations = schema.fields
    .filter((field) => !included.has(field.name))
    .map((field) => `  const ${field.name}: ${tsType(field)} = ${literal(field.default)};`);
  const checks = fields.map((field) => FIELD_TYPES[field.type].guestCheck(field));
  const assignments = schema.fields.flatMap((field) => FIELD_TYPES[field.type].assignment(field, schema.primaryField));
  return [
    `export function ${tierDecoderName(tier)}(nodeId: number, eventType: string${parameters ? `, ${parameters}` : ""}): DecodedHostEvent | null {`,
    ...declarations,
    ...(checks.length ? [`  if (${checks.join(" ||\n      ")}) return null;`] : []),
    `  const out: DecodedHostEvent = { n: nodeId, t: eventType, ${schema.primaryField} };`,
    ...assignments,
    "  return out;",
    "}",
  ].join("\n");
}

export function eventTypeScriptModule(schema) {
  const constants = schema.fields
    .filter((field) => field.type === "string")
    .map((field) => `export const EVENT_${upperSnake(field.name)}_LIMIT = ${field.maximum};`)
    .join("\n");
  const outputFields = schema.fields.map((field) => `  ${FIELD_TYPES[field.type].output(field, schema.primaryField)}`).join("\n");
  return [
    "// generated from abi/events.json by abi/generate.mjs — do not edit",
    constants,
    "",
    "export interface DecodedHostEvent {",
    "  n: number;",
    "  t: string;",
    outputFields,
    "}",
    "",
    ...schema.dispatch.flatMap((tier) => [decoder(schema, tier), ""]),
  ].join("\n");
}

export function nativeEventTypeScriptModule(schema) {
  const constants = schema.fields
    .filter((field) => field.type === "string")
    .map((field) => `const EVENT_${upperSnake(field.name)}_LIMIT = ${field.maximum};`)
    .join("\n");
  const messageFields = schema.fields.map((field) => `  ${field.name}: ${tsType(field)};`).join("\n");
  const messageKeys = requiredMessageKeys(schema);
  const messageLocals = messageKeys.map((key) => `  const ${key} = message[${JSON.stringify(key)}];`);
  const messageObject = `{ ${messageKeys.join(", ")} }`;
  const callbackType = ["slot: number", ...schema.fields.map((field) => `${field.name}: ${tsType(field)}`)].join(", ");
  return [
    "// generated from abi/events.json by abi/generate.mjs — do not edit",
    `export const EVENT_PROTOCOL_VERSION = ${schema.nativeMessage.version};`,
    `export const EVENT_MESSAGE_KIND = ${JSON.stringify(schema.nativeMessage.kind)};`,
    constants,
    "",
    "export interface NativeEventMessage {",
    "  version: number;",
    "  kind: string;",
    "  slot: number;",
    messageFields,
    "}",
    "",
    `export type NativeEventCallback = (${callbackType}) => void;`,
    "",
    `export const NATIVE_EVENT_BRIDGE_JS = ${JSON.stringify(nativeBridgeSource(schema))};`,
    "",
    "export function parseNativeEventMessage(raw: string): NativeEventMessage | null {",
    "  let input: unknown;",
    "  try { input = JSON.parse(raw) as unknown; } catch (_error) { return null; }",
    "  if (input === null || typeof input !== \"object\" || Array.isArray(input)) return null;",
    "  const message = input as Record<string, unknown>;",
    `  if (Object.keys(message).length !== ${messageKeys.length} ||`,
    `      ${messageKeys.map((key) => `!Object.hasOwn(message, ${JSON.stringify(key)})`).join(" ||\n      ")}) return null;`,
    ...messageLocals,
    `  if (${localMessageChecks(schema).join(" ||\n      ")}) return null;`,
    `  return ${messageObject};`,
    "}",
    "",
    "export function dispatchNativeEvent(message: NativeEventMessage, callback: NativeEventCallback): void {",
    `  callback(${callbackArguments(schema).map((name) => `message.${name}`).join(", ")});`,
    "}",
    "",
  ].join("\n");
}

export function eventHostModule(schema) {
  return [
    "// generated from abi/events.json by abi/generate.mjs — do not edit",
    "export function bindEventCallbacks(target, resolve, symbolPrefix) {",
    "  if (target === null || typeof target !== \"object\" || typeof resolve !== \"function\" ||",
    "      typeof symbolPrefix !== \"string\" || !/^[a-z][a-z0-9]*$/.test(symbolPrefix)) {",
    "    throw new Error(\"invalid generated event binding\");",
    "  }",
    "  var prefix = symbolPrefix + \"_\";",
    ...schema.dispatch.map((tier) =>
      `  var ${tier.semantics}Symbol = prefix + ${JSON.stringify(lowerSnake(tier.export))};`),
    ...schema.dispatch.map((tier) => bridgeBody(schema, tier)),
    "  return function () {",
    ...schema.dispatch.map((tier) =>
      `    if (target[${JSON.stringify(tier.callback)}] === ${tier.semantics}Bridge) delete target[${JSON.stringify(tier.callback)}];`),
    "  };",
    "}",
    "",
  ].join("\n");
}

export function nativeEventHostModule(schema) {
  const exact = exactMessageCheck(schema, "message");
  return [
    "// generated from abi/events.json by abi/generate.mjs — do not edit",
    `export const EVENT_PROTOCOL_VERSION = ${schema.nativeMessage.version};`,
    `export const EVENT_MESSAGE_KIND = ${JSON.stringify(schema.nativeMessage.kind)};`,
    `export const NATIVE_EVENT_BRIDGE_JS = ${JSON.stringify(nativeBridgeSource(schema))};`,
    "",
    "export function decodeNativeEventMessage(message) {",
    `  if (${exact.join(" ||\n      ")} ||`,
    `      ${messageChecks(schema, true).join(" ||\n      ")}) return null;`,
    "  return message;",
    "}",
    "",
    "export function parseNativeEventMessage(raw) {",
    "  try { return decodeNativeEventMessage(JSON.parse(raw)); } catch { return null; }",
    "}",
    "",
  ].join("\n");
}

export function coreEventDispatch(schema) {
  return schema.dispatch.map((tier) => {
    const fields = tierFields(schema, tier);
    const parameters = ["slot: number", ...fields.map((field) => `${field.name}: ${tsType(field)}`)].join(", ");
    const decoderArgs = ["nodeId", "eventType", ...fields.map((field) => field.name)].join(", ");
    return [
      `export function ${tierDispatchName(tier)}(${parameters}): void {`,
      "  const handler = handlerFns[slot];",
      "  if (handler === undefined || !handlerActive[slot]) return;",
      "  const nodeId = handlerNodeIds[slot];",
      "  const eventType = handlerEventTypes[slot];",
      "  if (nodeId === undefined || eventType === undefined) return;",
      `  const event = ${tierDecoderName(tier)}(${decoderArgs});`,
      "  if (event !== null) handler(event);",
      "}",
    ].join("\n");
  }).join("\n\n");
}

export function renderEventExport(schema) {
  return schema.dispatch.map((tier) => {
    const fields = tierFields(schema, tier);
    const parameters = ["slot: number", ...fields.map((field) => `${field.name}: ${tsType(field)}`)];
    return [
      `export function ${tier.export}(`,
      ...parameters.map((parameter) => `  ${parameter},`),
      "): number {",
      `  ${tierDispatchName(tier)}(${["slot", ...fields.map((field) => field.name)].join(", ")});`,
      "  flush();",
      "  return 0;",
      "}",
    ].join("\n");
  }).join("\n\n");
}

export function updateEventProfile(schema, previous) {
  const profile = JSON.parse(previous);
  if (!profile || typeof profile !== "object" || !profile.abi || !Array.isArray(profile.exports) ||
      typeof profile.abi.prefix !== "string" || !/^[a-z][a-z0-9]*_$/.test(profile.abi.prefix)) {
    throw new Error("profile has an invalid ABI/export shape");
  }
  const eventNames = new Set(schema.dispatch.map((tier) => tier.export));
  const existing = new Map();
  let insertAt = profile.exports.length;
  for (let index = 0; index < profile.exports.length; index++) {
    const entry = profile.exports[index];
    if (!eventNames.has(entry.export)) continue;
    if (existing.has(entry.export)) throw new Error(`profile must contain at most one ${entry.export} export`);
    existing.set(entry.export, entry);
    insertAt = Math.min(insertAt, index);
  }
  const retained = profile.exports.filter((entry) => !eventNames.has(entry.export));
  if (insertAt === profile.exports.length) insertAt = retained.length;
  else insertAt = profile.exports.slice(0, insertAt).filter((entry) => !eventNames.has(entry.export)).length;
  const generated = schema.dispatch.map((tier) => ({
    export: tier.export,
    symbol: profile.abi.prefix + lowerSnake(tier.export),
    params: ["f64", ...tierFields(schema, tier).map(profileType)],
    returns: "f64",
  }));
  retained.splice(insertAt, 0, ...generated);
  profile.exports = retained;
  return JSON.stringify(profile, null, 2) + "\n";
}
