import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { readEventSchema, validateEventSchema } from "./event-schema.mjs";
import { tierFields, updateEventProfile } from "./event-codegen.mjs";
import { bindEventCallbacks } from "../host/event.generated.mjs";
import { NATIVE_EVENT_BRIDGE_JS, parseNativeEventMessage } from "../host/native-event.generated.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readEventSchema(join(here, "events.json"));
const copy = () => JSON.parse(JSON.stringify(schema));
const rejected = (change, message) => {
  const candidate = copy();
  change(candidate);
  assert.throws(() => validateEventSchema(candidate), message);
};

rejected((value) => { value.extra = true; }, /fields must be exactly/, "unknown top-level fields fail closed");
rejected((value) => { delete value.fields[0].default; }, /fields must be exactly/, "missing field metadata fails closed");
rejected((value) => { value.fields[0].type = "json"; }, /type is unknown/, "unknown field kinds fail closed");
rejected((value) => { value.fields[0].source = "targetHtml"; }, /source is unknown/, "unknown projections fail closed");
rejected((value) => { value.fields[1].name = value.fields[0].name; }, /duplicate/, "duplicate fields fail closed");
rejected((value) => { value.primaryField = "checked"; }, /primaryField/, "primary value must remain textual");
rejected((value) => { value.nativeMessage.version = 0; }, /positive integer/, "message versions are positive");
rejected((value) => { value.safeEvents.push(value.safeEvents[0]); }, /duplicate safe event/, "event allowlist is unique");
rejected((value) => { value.dispatch.pop(); }, /exactly default, primary, and rich/, "missing tiers fail closed");
rejected((value) => { value.dispatch[1].extra = true; }, /fields must be exactly/, "unknown tier metadata fails closed");
rejected((value) => { value.dispatch[1].semantics = "rich"; }, /semantics must be primary/, "tier semantics and ordering are fixed");
rejected((value) => { value.dispatch[1].callback = value.dispatch[0].callback; }, /unique private/, "tier callbacks are unique");
rejected((value) => { value.dispatch[1].export = value.dispatch[0].export; }, /unique export/, "tier exports are unique");

const sampleValue = (field) => {
  if (field.type === "string") return field.name;
  if (field.type === "triBoolean") return 1;
  return Math.min(8, field.maximum);
};
const invalidValue = (field) => {
  if (field.type === "string") return "x".repeat(field.maximum + 1);
  if (field.type === "triBoolean") return 2;
  return field.maximum + 1;
};
const symbol = (name) => "nt_" + name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const forwarded = [];
const api = {};
for (const tier of schema.dispatch) api[symbol(tier.export)] = (...args) => { forwarded.push([tier.semantics, args]); };
const target = {};
const unbind = bindEventCallbacks(target, () => api, "nt");

for (const tier of schema.dispatch) {
  const fields = tierFields(schema, tier);
  const expected = [5, ...fields.map(sampleValue)];
  assert.equal(target[tier.callback](...expected), true, `${tier.semantics} bridge accepts its generated arity`);
  assert.deepEqual(forwarded.pop(), [tier.semantics, expected]);
  assert.equal(target[tier.callback](...expected.slice(0, -1)), false, `${tier.semantics} rejects missing arguments`);
  assert.equal(target[tier.callback](...expected, "extra"), false, `${tier.semantics} rejects extra arguments`);
  for (let index = 0; index < fields.length; index++) {
    const invalid = expected.slice();
    invalid[index + 1] = invalidValue(fields[index]);
    assert.equal(target[tier.callback](...invalid), false, `invalid ${tier.semantics}.${fields[index].name} does not dispatch`);
  }
}
assert.equal(forwarded.length, 0);
const retained = () => true;
target[schema.dispatch[1].callback] = retained;
unbind();
assert.equal(target[schema.dispatch[0].callback], undefined, "cleanup removes its unchanged default callback");
assert.equal(target[schema.dispatch[1].callback], retained, "cleanup preserves a callback replaced by its owner");
assert.equal(target[schema.dispatch[2].callback], undefined, "cleanup removes its unchanged rich callback");
assert.throws(() => bindEventCallbacks({}, () => api, "nt-unsafe"), /invalid generated event binding/);

const sent = [];
const sandbox = { window: { __nt_send: (raw) => sent.push(raw) }, JSON, Math };
vm.createContext(sandbox);
vm.runInContext(NATIVE_EVENT_BRIDGE_JS, sandbox);
for (const tier of schema.dispatch) {
  const fields = tierFields(schema, tier);
  const args = [5, ...fields.map(sampleValue)];
  assert.equal(sandbox.window[tier.callback](...args), true, `native ${tier.semantics} bridge accepts exact arity`);
  const nativeMessage = parseNativeEventMessage(sent.pop());
  assert.ok(nativeMessage, `native ${tier.semantics} bridge emits a strict full message`);
  assert.equal(nativeMessage.version, schema.nativeMessage.version);
  assert.equal(nativeMessage.kind, schema.nativeMessage.kind);
  assert.equal(nativeMessage.slot, args[0]);
  for (const field of schema.fields) {
    const included = fields.findIndex((candidate) => candidate.name === field.name);
    assert.equal(nativeMessage[field.name], included < 0 ? field.default : args[included + 1]);
  }
}

const rich = schema.dispatch.find((tier) => tier.semantics === "rich");
const richArgs = [5, ...schema.fields.map(sampleValue)];
sandbox.window[rich.callback](...richArgs);
const malformed = JSON.parse(sent.pop());
for (const key of Object.keys(malformed)) {
  const missing = { ...malformed };
  delete missing[key];
  assert.equal(parseNativeEventMessage(JSON.stringify(missing)), null, `missing ${key} fails closed`);
}
for (const field of schema.fields) {
  assert.equal(
    parseNativeEventMessage(JSON.stringify({ ...malformed, [field.name]: invalidValue(field) })),
    null,
    `invalid message ${field.name} fails closed`,
  );
}
assert.equal(parseNativeEventMessage(JSON.stringify({ ...malformed, extra: true })), null, "extra message fields fail closed");
assert.equal(parseNativeEventMessage(JSON.stringify({ ...malformed, kind: "unknown" })), null, "unknown message kinds fail closed");
assert.equal(parseNativeEventMessage(JSON.stringify({ ...malformed, version: malformed.version + 1 })), null, "unknown message versions fail closed");
assert.equal(parseNativeEventMessage("{"), null, "malformed JSON fails closed");

const profile = JSON.parse(updateEventProfile(schema, readFileSync(join(here, "../web/profile.json"), "utf8")));
for (const tier of schema.dispatch) {
  const entries = profile.exports.filter((entry) => entry.export === tier.export);
  assert.equal(entries.length, 1, `profile has exactly one generated ${tier.export}`);
  assert.equal(entries[0].symbol, symbol(tier.export));
  assert.deepEqual(entries[0].params, ["f64", ...tierFields(schema, tier).map((field) => field.type === "string" ? "string" : "f64")]);
}

console.log("event contract: strict schema, generated tiers, profiles, bridges, exact arity, bounds, kind, version, and cleanup passed");
