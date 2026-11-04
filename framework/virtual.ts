import { EVENT_SCROLL_TOP_LIMIT } from "./event.generated.js";
import { el, txt, attr, dynAttr, onEvent, each, type El, type KeyedItem } from "./ui.js";
import { signal, type Signal } from "./reactive.js";

export interface VisibleRange { first: number; end: number; top: number; bottom: number; }
export interface VirtualListOptions {
  count: () => number;
  key: (index: number) => string;
  render: (index: number) => El;
  rowHeight: number;
  height: number;
  overscan: number;
  scrollTop: Signal<number>;
}

export function visibleRange(count: number, rowHeight: number, height: number, scrollTop: number, overscan: number): VisibleRange {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(rowHeight) || rowHeight <= 0 ||
      !Number.isFinite(height) || height <= 0 || !Number.isFinite(scrollTop) || scrollTop < 0 ||
      !Number.isSafeInteger(overscan) || overscan < 0 || overscan > 1000 || count * rowHeight > EVENT_SCROLL_TOP_LIMIT) {
    throw new Error("invalid virtual list geometry");
  }
  const offset = Math.min(scrollTop, Math.max(0, count * rowHeight - height));
  const first = Math.max(0, Math.floor(offset / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((offset + height) / rowHeight) + overscan);
  return { first, end, top: first * rowHeight, bottom: (count - end) * rowHeight };
}

export function virtualList(options: VirtualListOptions): El {
  const range = (): VisibleRange => visibleRange(options.count(), options.rowHeight, options.height, options.scrollTop.get(), options.overscan);
  const rows = each("div", () => {
    const visible = range();
    const items: KeyedItem[] = [];
    for (let index = visible.first; index < visible.end; index++) {
      const row = index;
      items.push({ key: options.key(row) + ":" + row, build: () => attr(el("div", [options.render(row)]), "style", "height:" + options.rowHeight + "px;box-sizing:border-box") });
    }
    return items;
  });
  dynAttr(rows, "style", () => {
    const visible = range();
    return "padding-top:" + visible.top + "px;padding-bottom:" + visible.bottom + "px";
  });
  return onEvent(attr(el("div", [rows]), "style", "overflow:auto;height:" + options.height + "px;overflow-anchor:none"), "scroll", (event) => {
    options.scrollTop.set(event.scrollTop ?? 0);
  });
}

export interface VirtualColumn {
  header: string;
  cell: (row: number) => El;
}

export function virtualTable(count: () => number, key: (row: number) => string, columns: VirtualColumn[], rowHeight: number, height: number): El {
  if (columns.length === 0 || columns.length > 64) throw new Error("virtual table column limit");
  const grid = "display:grid;grid-template-columns:repeat(" + columns.length + ",minmax(0,1fr))";
  const headers: El[] = [];
  for (let i = 0; i < columns.length; i++) headers.push(attr(el("div", [txt(columns[i]!.header)]), "role", "columnheader"));
  const header = attr(attr(el("div", headers), "role", "row"), "style", grid);
  const list = virtualList({
    count, key, rowHeight, height, overscan: 3, scrollTop: signal(0),
    render: (row: number) => {
      const cells: El[] = [];
      for (let i = 0; i < columns.length; i++) cells.push(attr(el("div", [columns[i]!.cell(row)]), "role", "cell"));
      return attr(el("div", [attr(el("div", cells), "style", grid)]), "role", "row");
    },
  });
  return attr(el("div", [header, list]), "role", "table");
}
