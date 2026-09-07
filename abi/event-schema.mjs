import { readFileSync } from "node:fs";

const IDENTIFIER = /^[a-z][A-Za-z0-9]*$/;
const CALLBACK = /^__[a-z][A-Za-z0-9_]*$/;
const EXPORT = /^[a-z][A-Za-z0-9]*$/;
const EVENT_NAME = /^[a-z][a-z0-9-]*$/;
const RESERVED_MESSAGE_FIELDS = new Set(["version", "kind", "slot"]);
const DISPATCH_SEMANTICS = ["default", "primary", "rich"];

const FIELD_KINDS = {
  string: {
    keys: ["name", "type", "source", "maximum", "default"],
    valid(field) {
      return typeof field.default === "string" && Number.isInteger(field.maximum) &&
        field.maximum >= 0 && field.maximum <= 1048576 && field.default.length <= field.maximum;
    },
  },
  triBoolean: {
    keys: ["name", "type", "source", "default"],
    valid(field) {
      return field.default === -1 || field.default === 0 || field.default === 1;
    },
  },
  modifierBits: {
    keys: ["name", "type", "source", "maximum", "default"],
    valid(field) {
      return Number.isInteger(field.maximum) && field.maximum >= 0 && field.maximum <= 255 &&
        Number.isInteger(field.default) && field.default >= 0 && field.default <= field.maximum;
    },
  },
};

const SOURCE_KINDS = {
  targetValue: "string",
  targetChecked: "triBoolean",
  eventKey: "string",
  eventCode: "string",
  eventModifiers: "modifierBits",
  eventInputType: "string",
};

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(path + " must be an object");
  }
  return value;
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(record(value, path)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(path + " fields must be exactly: " + wanted.join(", "));
  }
}

function validateField(field, index, names) {
  const path = `events.fields[${index}]`;
  const value = record(field, path);
  const definition = FIELD_KINDS[value.type];
  if (!definition) throw new Error(path + ".type is unknown: " + value.type);
  exactKeys(value, definition.keys, path);
  if (typeof value.name !== "string" || !IDENTIFIER.test(value.name) || RESERVED_MESSAGE_FIELDS.has(value.name)) {
    throw new Error(path + ".name is invalid or reserved");
  }
  if (names.has(value.name)) throw new Error("duplicate event field: " + value.name);
  names.add(value.name);
  if (SOURCE_KINDS[value.source] !== value.type) {
    throw new Error(path + ".source is unknown or incompatible with " + value.type);
  }
  if (!definition.valid(value)) throw new Error(path + " has an invalid bound or default");
}

function validateDispatch(dispatch) {
  if (!Array.isArray(dispatch) || dispatch.length !== DISPATCH_SEMANTICS.length) {
    throw new Error("events.dispatch must define exactly default, primary, and rich tiers");
  }
  const callbacks = new Set();
  const exports = new Set();
  for (let index = 0; index < dispatch.length; index++) {
    const tier = record(dispatch[index], `events.dispatch[${index}]`);
    exactKeys(tier, ["semantics", "callback", "export"], `events.dispatch[${index}]`);
    if (tier.semantics !== DISPATCH_SEMANTICS[index]) {
      throw new Error(`events.dispatch[${index}].semantics must be ${DISPATCH_SEMANTICS[index]}`);
    }
    if (typeof tier.callback !== "string" || !CALLBACK.test(tier.callback) || callbacks.has(tier.callback)) {
      throw new Error(`events.dispatch[${index}].callback must be a unique private JavaScript identifier`);
    }
    if (typeof tier.export !== "string" || !EXPORT.test(tier.export) || exports.has(tier.export)) {
      throw new Error(`events.dispatch[${index}].export must be a unique export identifier`);
    }
    callbacks.add(tier.callback);
    exports.add(tier.export);
  }
}

export function validateEventSchema(input) {
  const schema = record(input, "events");
  exactKeys(schema, ["format", "nativeMessage", "primaryField", "dispatch", "fields", "safeEvents"], "events");
  if (schema.format !== 2) throw new Error("unsupported event schema format: " + schema.format);

  exactKeys(schema.nativeMessage, ["version", "kind"], "events.nativeMessage");
  if (!Number.isInteger(schema.nativeMessage.version) || schema.nativeMessage.version < 1) {
    throw new Error("events.nativeMessage.version must be a positive integer");
  }
  if (typeof schema.nativeMessage.kind !== "string" || !IDENTIFIER.test(schema.nativeMessage.kind)) {
    throw new Error("events.nativeMessage.kind is invalid");
  }
  validateDispatch(schema.dispatch);

  if (!Array.isArray(schema.fields) || schema.fields.length === 0 || schema.fields.length > 32) {
    throw new Error("events.fields must contain between 1 and 32 fields");
  }
  const names = new Set();
  schema.fields.forEach((field, index) => validateField(field, index, names));
  const primary = schema.fields.find((field) => field.name === schema.primaryField);
  if (!primary || primary.type !== "string") {
    throw new Error("events.primaryField must name a declared string field");
  }

  if (!Array.isArray(schema.safeEvents) || schema.safeEvents.length === 0 || schema.safeEvents.length > 64) {
    throw new Error("events.safeEvents must contain between 1 and 64 names");
  }
  const safe = new Set();
  for (const name of schema.safeEvents) {
    if (typeof name !== "string" || !EVENT_NAME.test(name)) throw new Error("invalid safe event: " + name);
    if (safe.has(name)) throw new Error("duplicate safe event: " + name);
    safe.add(name);
  }
  return schema;
}

export function readEventSchema(path) {
  return validateEventSchema(JSON.parse(readFileSync(path, "utf8")));
}
