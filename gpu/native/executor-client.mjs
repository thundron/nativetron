// Client for ntgpu-executor-driver (see executor-driver.cc): encodes [operationName, ...operands] tuples exactly as
// the generated guest functions do (same wire as gpu/verify.mjs), submits them to the native executor and collects
// the events the embedding would deliver. Used by executor.test.mjs and executor-corpus.mjs.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import * as generated from "../gpu-host.generated.js";

const spec = JSON.parse(readFileSync(new URL("../ops.json", import.meta.url), "utf8"));
const camel = (name) => name.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const ops = new Map(spec.ops.filter((op) => !op.header).map((op) => [camel(op.name), op]));

export const C = generated;
export const E = { CAPABILITIES: 1, PIPELINE_READY: 2, MAP_READY: 3, WORK_DONE: 4, DEVICE_LOST: 5, UNCAUGHT_ERROR: 6, SHADER_INFO: 7, RESIZE: 8, ERROR: 9 };
export const S = { OK: 0, ERROR: 1, CANCELLED: 2, LOST: 3 };
export const h = (slot, generation = 1) => generation * 2 ** 20 + slot;

export function header(version = generated.GPU_PROTOCOL_VERSION, identity = generated.GPU_PROTOCOL_IDENTITY) {
  const bytes = Buffer.alloc(generated.GPU_PROTOCOL_HEADER_BYTES);
  bytes[0] = generated.GPU_PROTOCOL_OPCODE;
  bytes.writeUInt32LE(version, 1);
  bytes.writeUInt32LE(identity, 5);
  return bytes;
}

export function encode(operations, head = header()) {
  const chunks = head ? [head] : [];
  const scalar = (type, value) => {
    const bytes = Buffer.alloc(type === "f64" ? 8 : type === "bool" ? 1 : 4);
    if (type === "f64") bytes.writeDoubleLE(value);
    else if (type === "f32") bytes.writeFloatLE(value);
    else if (type === "i32") bytes.writeInt32LE(value);
    else if (type === "bool") bytes[0] = value ? 1 : 0;
    else bytes.writeUInt32LE(value >>> 0);
    chunks.push(bytes);
  };
  for (const [name, ...values] of operations) {
    const op = ops.get(name);
    if (!op) throw new Error(`unknown operation ${name}`);
    chunks.push(Buffer.from([op.code]));
    if (op.result) scalar("u32", values[0]);
    let index = op.result ? 1 : 0;
    for (const arg of op.args) {
      const type = arg.split(":")[1], value = values[index++];
      if (type === "str") { const b = Buffer.from(value); scalar("u32", b.length); chunks.push(b); }
      else if (type.endsWith("[]")) { scalar("u32", value.length); for (const item of value) scalar(type === "f64[]" ? "f64" : "u32", item); }
      else if (type === "upload" || type === "readback") { scalar("u32", value.offset); scalar("u32", value.length); }
      else scalar(type, value);
    }
    if (index !== values.length) throw new Error(`${name}: ${values.length} operands, expected ${index}`);
  }
  return Buffer.concat(chunks);
}

export class Driver {
  static async start(path, args = []) {
    const driver = new Driver(spawn(path, args, { stdio: ["pipe", "pipe", "inherit"] }));
    const ready = await driver.next();
    if (ready.ready !== 1) throw new Error("executor driver failed to start");
    return driver;
  }
  constructor(child) {
    this.child = child;
    this.events = [];   // every event, in delivery order
    this.frames = 0;
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const value = JSON.parse(line);
      if (value.event) {
        const event = value.event;
        if (value.bytes !== undefined) Object.defineProperty(event, "payload", { value: { bytes: value.bytes, hash: value.hash, data: value.data ? Buffer.from(value.data, "base64") : null }, enumerable: false });
        this.events.push(event);
      } else if (value.frame) this.frames++;
      else if (this.waiters.length) this.waiters.shift()(value);
      else this.lines.push(value);
    });
    child.on("exit", () => { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ exited: true }); });
  }
  next() { return this.lines.length ? Promise.resolve(this.lines.shift()) : new Promise((resolve) => this.waiters.push(resolve)); }
  async command(line, payload) {
    const before = this.events.length;
    this.child.stdin.write(line + "\n");
    if (payload) this.child.stdin.write(payload);
    const result = await this.next();
    return { ...result, events: this.events.slice(before) };
  }
  submit(operations, { uploads = Buffer.alloc(0), readback = 1 << 20, head } = {}) {
    const bytes = Buffer.isBuffer(operations) ? operations : encode(operations, head);
    return this.command(`submit ${bytes.length} ${uploads.length} ${readback}`, Buffer.concat([bytes, uploads]));
  }
  claim(operations, uploadClaim, readbackClaim) {
    const bytes = encode(operations);
    return this.command(`claim ${bytes.length} ${uploadClaim} ${readbackClaim}`, bytes);
  }
  wait(ms = 10000) { return this.command(`wait ${ms}`); }
  process() { return this.command("process"); }
  resize(width, height, dpr) { return this.command(`resize ${width} ${height} ${dpr}`); }
  capture() { return this.command("capture"); }
  lose() { return this.command("lose"); }
  stats() { return this.command("stats"); }
  sleep(ms) { return this.command(`sleep ${ms}`); }
  async quit() {
    if (this.closed) return;
    const done = new Promise((resolve) => this.child.on("exit", resolve));
    this.child.stdin.end("quit\n");
    await done;
  }
  terminal(id) { return this.events.filter((event) => event.requestId === id && generated.GPU_TERMINAL_EVENTS.has(event.type)); }
  errors() { return this.events.filter((event) => event.type === E.ERROR); }
}

// Device request with the protocol's default limits; resolves to the CAPABILITIES event.
export async function connect(driver, id = 1, { featureBits = 0, limits = [], power = C.POWER_HIGH_PERFORMANCE } = {}) {
  await driver.submit([["requestDeviceWith", id, power, 0, featureBits, limits]]);
  const [event] = driver.terminal(id);
  if (!event || event.status !== S.OK) throw new Error(`device request failed: ${JSON.stringify(event)}`);
  return event;
}
