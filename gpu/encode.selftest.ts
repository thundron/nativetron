import { u32, i32, setSink, flush } from "./encode.js";
import { createBuffer, destroy, BUFFER_USAGE_COPY_DST } from "./gpu.generated.js";
import { PROTOCOL_OPCODE, PROTOCOL_VERSION, PROTOCOL_IDENTITY, PROTOCOL_HEADER_BYTES } from "./limits.generated.js";
let refused = 0;
try { u32(1.5); } catch { refused++; }
try { u32(-1); } catch { refused++; }
try { u32(4294967296); } catch { refused++; }
try { i32(2147483648); } catch { refused++; }
try { i32(-2147483649); } catch { refused++; }
// A refused operand rolls back the partial operation and its unsent handle.
let rolledBack = 0;
try { createBuffer(64, 0.5, false, "refused"); } catch { rolledBack++; }
const first = createBuffer(64, BUFFER_USAGE_COPY_DST, false, "first");
destroy(first);
const second = createBuffer(64, BUFFER_USAGE_COPY_DST, false, "second");
let batches = 0;
setSink((bytes: Uint8Array, _upload: Uint8Array, _readback: Uint8Array) => {
  batches++;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = bytes[0] === PROTOCOL_OPCODE && view.getUint32(1, true) === PROTOCOL_VERSION && view.getUint32(5, true) === PROTOCOL_IDENTITY ? "header" : "no-header";
  const base = PROTOCOL_HEADER_BYTES;
  // createBuffer(first) is the first operation: the refused one left no bytes behind.
  const firstHandle = view.getUint32(base + 1, true);
  console.log(`${refused}/${rolledBack}/${header}/${firstHandle === first ? "rolled-back" : "leaked"}/${first}/${second}/${bytes.byteLength}`);
});
flush();
setSink((bytes: Uint8Array, _upload: Uint8Array, _readback: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  console.log(`${view.getUint32(PROTOCOL_HEADER_BYTES, true)}/${view.getInt32(PROTOCOL_HEADER_BYTES + 4, true)}/${bytes.byteLength}`);
});
u32(4294967295);
i32(-2147483648);
flush();
flush();
console.log(`batches ${batches}`);
