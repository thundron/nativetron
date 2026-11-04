import { visibleRange, virtualWindow, type VirtualWindow } from "./virtual.js";
const middle = visibleRange(10000, 24, 240, 120000, 3);
console.log(`${middle.first}/${middle.end}/${middle.top}/${middle.bottom}`);
const empty = visibleRange(0, 24, 240, 0, 3);
console.log(`${empty.first}/${empty.end}`);
const shrink = visibleRange(5, 24, 240, 120000, 3);
console.log(`${shrink.first}/${shrink.end}`);
try { visibleRange(10, 0, 240, 0, 3); console.log("accepted invalid height"); } catch { console.log("invalid height refused"); }
try { visibleRange(10, 24, 240, -1, 3); console.log("accepted invalid offset"); } catch { console.log("invalid offset refused"); }

function show(label: string, w: VirtualWindow): void {
  console.log(`${label} ${w.first}/${w.end} top=${w.top} bottom=${w.bottom} active=${w.active} before=${w.activeBefore ? 1 : 0} gap=${w.gap}`);
}
// Every window must account for exactly count * rowHeight logical pixels.
function total(count: number, rowHeight: number, w: VirtualWindow): boolean {
  const mounted = (w.end - w.first) + (w.active >= 0 ? 1 : 0);
  return w.top + w.bottom + w.gap + mounted * rowHeight === count * rowHeight;
}
const collapsed = visibleRange(100, 24, 0, 240, 3);
console.log(`collapsed ${collapsed.first}/${collapsed.end}`);
const grown = visibleRange(10000, 24, 480, 0, 3);
console.log(`grown viewport ${grown.first}/${grown.end}`);
const fraction = visibleRange(10000, 24, 240, 1234.5, 0);
console.log(`fractional ${fraction.first}/${fraction.end}`);
const huge = visibleRange(1000000, 16, 320, 15999680, 3);
console.log(`huge end ${huge.first}/${huge.end} bottom=${huge.bottom}`);
const hugeMiddle = visibleRange(1000000, 16, 320, 8000000, 3);
console.log(`huge middle ${hugeMiddle.first}/${hugeMiddle.end}`);
try { visibleRange(67108865, 16, 320, 0, 3); console.log("accepted oversized collection"); } catch { console.log("oversized collection refused"); }
try { visibleRange(1.5, 24, 240, 0, 3); console.log("accepted fractional count"); } catch { console.log("fractional count refused"); }
try { visibleRange(10, 24, 240, 0, 1001); console.log("accepted overscan"); } catch { console.log("overscan bound refused"); }

const inside = virtualWindow(10000, 24, 240, 0, 3, 5);
show("inside", inside);
const before = virtualWindow(10000, 24, 240, 120000, 3, 2);
show("before", before);
const after = virtualWindow(10000, 24, 240, 0, 3, 9000);
show("after", after);
const adjacent = virtualWindow(10000, 24, 240, 120000, 3, 4996);
show("adjacent", adjacent);
const gone = virtualWindow(5, 24, 240, 120000, 3, 9000);
show("unpinned", gone);
const none = virtualWindow(0, 24, 240, 0, 3, 0);
show("empty", none);
console.log(`totals ${total(10000, 24, inside) && total(10000, 24, before) && total(10000, 24, after) && total(10000, 24, adjacent) && total(5, 24, gone) && total(0, 24, none) ? "exact" : "wrong"}`);
try { virtualWindow(10, 24, 240, 0, 3, 0.5); console.log("accepted fractional active"); } catch { console.log("fractional active refused"); }
try { virtualWindow(10, 24, 240, 0, 3, -2); console.log("accepted negative active"); } catch { console.log("negative active refused"); }
