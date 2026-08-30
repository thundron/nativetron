import { FrameWriter, FrameReader, encodeUtf8, decodeUtf8 } from "../codec.js";
import { FRAME_REQUEST, FRAME_EVENT } from "../protocol.generated.js";

const w = new FrameWriter();
w.u8(FRAME_REQUEST);
w.u32(42);
w.str("spawn:pear");
w.bytes(encodeUtf8("héllo wörld"));
const f1 = w.finish();

const w2 = new FrameWriter();
w2.u8(FRAME_EVENT);
w2.str("log");
w2.bytes(encodeUtf8("line"));
const f2 = w2.finish();

const r = new FrameReader();
const joined = new Uint8Array(f1.length + f2.length);
joined.set(f1, 0);
joined.set(f2, f1.length);
r.push(joined.subarray(0, 3));
console.log("partial=" + (r.next() ? "yes" : "no"));
r.push(joined.subarray(3, joined.length));
let n = 0;
while (r.next()) {
  const kind = r.u8();
  if (kind === FRAME_REQUEST) {
    console.log("REQUEST id=" + r.u32() + " ch=" + r.str() + " payload=" + decodeUtf8(r.bytes()));
  } else {
    console.log("EVENT ch=" + r.str() + " payload=" + decodeUtf8(r.bytes()));
  }
  r.release();
  n = n + 1;
}
console.log("frames=" + n);
