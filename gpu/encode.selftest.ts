import { u32, i32, setSink, flush } from "./encode.js";
let refused = 0;
try { u32(1.5); } catch { refused++; }
try { u32(-1); } catch { refused++; }
try { u32(4294967296); } catch { refused++; }
try { i32(2147483648); } catch { refused++; }
try { i32(-2147483649); } catch { refused++; }
setSink((bytes: Uint8Array, _upload: Uint8Array, _readback: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  console.log(`${refused}/${view.getUint32(0, true)}/${view.getInt32(4, true)}`);
});
u32(4294967295);
i32(-2147483648);
flush();
