import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coreEventDispatch, eventHostModule, eventTable, eventTierTable, eventTypeScriptModule,
  hostEventConstants, hostEventProjection, nativeEventHostModule, nativeEventTypeScriptModule,
  renderEventExport, updateEventProfile,
} from "./event-codegen.mjs";
import { readEventSchema } from "./event-schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ARGUMENT = /^(?<name>[a-z][A-Za-z0-9]*)(?::(?<type>intern|str))?$/;
const operations = validateOperations(JSON.parse(readFileSync(join(here, "ops.json"), "utf8")));
const events = readEventSchema(join(here, "events.json"));
const check = process.argv.includes("--check");

function exactKeys(value, expected, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(path + " must be an object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(path + " fields must be exactly: " + wanted.join(", "));
  }
}

function operationArgument(value, path) {
  if (typeof value !== "string") throw new Error(path + " must be a string");
  const match = ARGUMENT.exec(value);
  if (match === null) throw new Error(path + " has an unknown operand kind");
  return { name: match.groups.name, type: match.groups.type ?? "u32" };
}

function validateOperations(schema) {
  exactKeys(schema, ["root", "ops"], "ops");
  if (!Number.isInteger(schema.root) || schema.root < 0 || schema.root > 4294967295) {
    throw new Error("ops.root must be a u32");
  }
  if (!Array.isArray(schema.ops) || schema.ops.length === 0 || schema.ops.length > 255) {
    throw new Error("ops.ops must contain between 1 and 255 operations");
  }
  const codes = new Set();
  const names = new Set();
  for (let index = 0; index < schema.ops.length; index++) {
    const operation = schema.ops[index];
    const path = `ops.ops[${index}]`;
    exactKeys(operation, ["code", "name", "args"], path);
    if (!Number.isInteger(operation.code) || operation.code < 1 || operation.code > 255 || codes.has(operation.code)) {
      throw new Error(path + ".code must be a unique nonzero u8");
    }
    if (typeof operation.name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(operation.name) || names.has(operation.name)) {
      throw new Error(path + ".name must be a unique upper-snake identifier");
    }
    if (!Array.isArray(operation.args)) throw new Error(path + ".args must be an array");
    operation.args.forEach((argument, argumentIndex) => operationArgument(argument, `${path}.args[${argumentIndex}]`));
    codes.add(operation.code);
    names.add(operation.name);
  }
  return schema;
}

const argument = (value) => operationArgument(value, "operation argument");
const operandDescription = { u32: "u32", intern: "u32 intern id", str: "length-prefixed utf-8" };
const operationTable = [
  "| opcode | name | arguments |",
  "|---|---|---|",
  ...operations.ops.map((operation) =>
    `| ${operation.code} | ${operation.name} | ${operation.args.map((value) => argument(value).name).join(", ") || "—"} |`),
].join("\n");
const operationLayout = operations.ops.map((operation) =>
  `    ${String(operation.code).padStart(2)} ${operation.name.padEnd(17)} ` +
  `${operation.args.map((value) => {
    const operand = argument(value);
    return `${operand.name}(${operandDescription[operand.type]})`;
  }).join(" ") || "—"}`).join("\n");

function generatedRegion(previous, name, body) {
  const start = `/* generated:${name} */`;
  const end = `/* /generated:${name} */`;
  const startAt = previous.indexOf(start);
  const endAt = previous.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0 || previous.indexOf(start, startAt + start.length) >= 0) {
    throw new Error(`expected exactly one generated region ${name}`);
  }
  return previous.slice(0, startAt + start.length) + "\n" + body + "\n" + previous.slice(endAt);
}

function markdownRegion(previous, name, body) {
  const start = `<!-- generated:${name} -->`;
  const end = `<!-- /generated:${name} -->`;
  const startAt = previous.indexOf(start);
  const endAt = previous.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0 || previous.indexOf(start, startAt + start.length) >= 0) {
    throw new Error(`expected exactly one generated markdown region ${name}`);
  }
  return previous.slice(0, startAt + start.length) + "\n" + body + "\n" + previous.slice(endAt);
}

function operationConstants() {
  return operations.ops.map((operation) => `  var OP_${operation.name} = ${operation.code};`).join("\n");
}

const targets = [
  {
    path: join(here, "DOM_HOST_ABI.md"),
    render(previous) {
      const operationsBody = `${operationTable}\n\nWire layout:\n\n\`\`\`\n${operationLayout}\n\`\`\``;
      const eventBody = [
        `Schema format ${events.format}; native event message version ${events.nativeMessage.version}, kind \`${events.nativeMessage.kind}\`.`,
        "",
        "Browser dispatch is selected by generated default-value semantics:",
        "",
        eventTierTable(events),
        "",
        "The rich tier has this generated field contract:",
        "",
        eventTable(events),
        "",
        "The callback shapes, tier selection, host projection, guest decoders/exports, native bridge, browser binders, bounds, and event allowlist are generated from `abi/events.json`.",
      ].join("\n");
      return markdownRegion(markdownRegion(previous, "ops", operationsBody), "events", eventBody);
    },
  },
  {
    path: join(here, "..", "framework", "ops.generated.ts"),
    render: () => "// generated from abi/ops.json by abi/generate.mjs — do not edit\n" +
      `export const ROOT_ID = ${operations.root};\n` +
      operations.ops.map((operation) => `export const OP_${operation.name} = ${operation.code};`).join("\n") + "\n",
  },
  { path: join(here, "..", "framework", "event.generated.ts"), render: () => eventTypeScriptModule(events) },
  {
    path: join(here, "..", "framework", "native-event.generated.ts"),
    render: () => nativeEventTypeScriptModule(events),
  },
  { path: join(here, "..", "host", "event.generated.mjs"), render: () => eventHostModule(events) },
  {
    path: join(here, "..", "host", "native-event.generated.mjs"),
    render: () => nativeEventHostModule(events),
  },
  {
    path: join(here, "..", "framework", "core.ts"),
    render: (previous) => generatedRegion(previous, "event-dispatch", coreEventDispatch(events)),
  },
  {
    path: join(here, "..", "host", "dom-host.js"),
    render(previous) {
      return generatedRegion(
        generatedRegion(
          generatedRegion(previous, "operation-constants", operationConstants()),
          "event-constants",
          hostEventConstants(events),
        ),
        "event-projection",
        hostEventProjection(events),
      );
    },
  },
  {
    path: join(here, "..", "web", "renderer.ts"),
    render: (previous) => generatedRegion(previous, "event-export", renderEventExport(events)),
  },
  {
    path: join(here, "..", "web", "profile.json"),
    render: (previous) => updateEventProfile(events, previous),
  },
  {
    path: join(here, "..", "bench", "web-runtime", "app", "counter.ts"),
    render: (previous) => generatedRegion(previous, "event-export", renderEventExport(events)),
  },
  {
    path: join(here, "..", "bench", "web-runtime", "app", "profile.json"),
    render: (previous) => updateEventProfile(events, previous),
  },
];

let stale = 0;
for (const target of targets) {
  let previous = "";
  try { previous = readFileSync(target.path, "utf8"); } catch {}
  const next = target.render(previous);
  if (next === previous) continue;
  stale++;
  if (check) console.error(`stale: ${target.path}`);
  else writeFileSync(target.path, next);
}
if (check && stale) {
  console.error(`${stale} generated file(s) out of date — run: node abi/generate.mjs`);
  process.exit(1);
}
console.log(check ? "abi: generated files up to date" : `abi: wrote ${stale} file(s)`);
