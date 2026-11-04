import { visibleRange } from "./virtual.js";
const middle = visibleRange(10000, 24, 240, 120000, 3);
console.log(`${middle.first}/${middle.end}/${middle.top}/${middle.bottom}`);
const empty = visibleRange(0, 24, 240, 0, 3);
console.log(`${empty.first}/${empty.end}`);
const shrink = visibleRange(5, 24, 240, 120000, 3);
console.log(`${shrink.first}/${shrink.end}`);
try { visibleRange(10, 0, 240, 0, 3); console.log("accepted invalid height"); } catch { console.log("invalid height refused"); }
try { visibleRange(10, 24, 240, -1, 3); console.log("accepted invalid offset"); } catch { console.log("invalid offset refused"); }
