import { PearNDJSONError, PearNDJSONParser, parseNDJSONChunks } from "./ndjson.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function expectError(code: string, run: () => void): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof PearNDJSONError && error.code === code;
  }
}

const source = bytes(
  '{"cmd":"stage","tag":"file","data":"a"}\r\n' +
  '{"cmd":"stage","tag":"future-tag","data":true}\n',
);
const events = parseNDJSONChunks([source.slice(0, 7), source.slice(7, 43), source.slice(43)]);
let ok = events.length === 2
  && events[0]!.cmd === "stage" && events[0]!.tag === "file" && events[0]!.known
  && events[1]!.tag === "future-tag" && !events[1]!.known
  && events[1]!.diagnostic!.type === "unknown-tag";

ok = ok && expectError("NDJSON_UTF8", () => {
  const parser = new PearNDJSONParser();
  parser.feed(new Uint8Array([0xff, 0x0a]));
});
ok = ok && expectError("NDJSON_JSON", () => {
  const parser = new PearNDJSONParser();
  parser.feed(bytes("{bad}\n"));
});
ok = ok && expectError("NDJSON_EVENT_SHAPE", () => {
  const parser = new PearNDJSONParser();
  parser.feed(bytes('{"cmd":"stage","tag":"file","extra":1}\n'));
});
ok = ok && expectError("NDJSON_ERROR_SHAPE", () => {
  const parser = new PearNDJSONParser();
  parser.feed(bytes('{"cmd":"stage","tag":"error","data":{"code":"E"}}\n'));
});
ok = ok && expectError("NDJSON_ERROR_SHAPE", () => {
  const parser = new PearNDJSONParser();
  parser.feed(bytes('{"cmd":"stage","tag":"error","data":"bad"}\n'));
});
ok = ok && expectError("NDJSON_OBJECT_DEPTH", () => {
  let nested = "null";
  for (let i = 0; i < 66; i++) nested = '{"x":' + nested + "}";
  const parser = new PearNDJSONParser();
  parser.feed(bytes('{"cmd":"info","tag":"info","data":' + nested + "}\n"));
});
ok = ok && expectError("NDJSON_LINE_LIMIT", () => {
  const parser = new PearNDJSONParser({ maxLineBytes: 8 });
  parser.feed(bytes("123456789"));
});
ok = ok && expectError("NDJSON_EVENT_LIMIT", () => {
  const parser = new PearNDJSONParser({ maxLineBytes: 128, maxObjectBytes: 128, maxEvents: 1, maxTotalBytes: 256 });
  parser.feed(bytes('{"cmd":"gc","tag":"core"}\n{"cmd":"gc","tag":"core"}\n'));
});

console.log(ok ? "PYRUS_NDJSON=OK" : "PYRUS_NDJSON=FAIL");
if (!ok) process.exit(1);
