import { EVENT_SCROLL_TOP_LIMIT } from "./event.generated.js";
import { newId, createElement, setAttr, append, remove, flush } from "./core.js";
import { el, txt, attr, dynAttr, dynProp, onEvent, each, component, disposeEl, type El, type KeyedItem } from "./ui.js";
import { signal, effect, onScopeCleanup, type Signal } from "./reactive.js";

export interface VisibleRange { first: number; end: number; top: number; bottom: number; }

/** A visible range plus at most one pinned active row outside it. */
export interface VirtualWindow {
  first: number;
  end: number;
  top: number;
  bottom: number;
  /** Pinned row index outside [first, end), or -1. */
  active: number;
  /** True when the pinned row precedes the visible range. */
  activeBefore: boolean;
  /** Height of the spacer between the pinned row and the visible range. */
  gap: number;
}

export interface VirtualListOptions {
  count: () => number;
  key: (index: number) => string;
  render: (index: number) => El;
  rowHeight: number;
  height: number;
  overscan: number;
  scrollTop: Signal<number>;
  /** Reactive viewport height in CSS pixels; replaces `height` when present. */
  viewport?: Signal<number>;
  autoSize?: boolean;
  /** Logical row kept mounted while it is outside the window (focus/editing); -1 for none. */
  activeIndex?: Signal<number>;
  /** Accessible name; also makes the scroll container keyboard-focusable. */
  label?: string;
}

/** Row handle for key-identity lists. `index()` is reactive and changes when the item moves. */
export interface VirtualRow {
  key: string;
  index: () => number;
}

export interface KeyedVirtualListOptions {
  count: () => number;
  key: (index: number) => string;
  renderRow: (row: VirtualRow) => El;
  rowHeight: number;
  height: number;
  overscan: number;
  scrollTop: Signal<number>;
  viewport?: Signal<number>;
  autoSize?: boolean;
  activeIndex?: Signal<number>;
  label?: string;
}

export interface VirtualColumn {
  header: string;
  cell: (row: number) => El;
}

export interface VirtualTableOptions {
  scrollTop?: Signal<number>;
  viewport?: Signal<number>;
  autoSize?: boolean;
  activeIndex?: Signal<number>;
  overscan?: number;
  label?: string;
}

export interface VirtualStats { lists: number; rows: number; }

let liveLists = 0;
let liveRows = 0;

/** Live virtual containers and mounted row shells across the module; both return to zero after disposal. */
export function virtualStats(): VirtualStats {
  return { lists: liveLists, rows: liveRows };
}

function invalid(): Error {
  return new Error("invalid virtual list geometry");
}

export function visibleRange(count: number, rowHeight: number, height: number, scrollTop: number, overscan: number): VisibleRange {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(rowHeight) || rowHeight <= 0 ||
      !Number.isFinite(height) || height < 0 || !Number.isFinite(scrollTop) || scrollTop < 0 ||
      !Number.isSafeInteger(overscan) || overscan < 0 || overscan > 1000 || count * rowHeight > EVENT_SCROLL_TOP_LIMIT ||
      height > EVENT_SCROLL_TOP_LIMIT) {
    throw invalid();
  }
  const offset = Math.min(scrollTop, Math.max(0, count * rowHeight - height));
  const first = Math.max(0, Math.floor(offset / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((offset + height) / rowHeight) + overscan);
  return { first, end, top: first * rowHeight, bottom: (count - end) * rowHeight };
}

/** `visibleRange` plus one pinned row. `active` outside [0, count) is ignored, so shrinking past it unpins. */
export function virtualWindow(count: number, rowHeight: number, height: number, scrollTop: number, overscan: number, active: number): VirtualWindow {
  const range = visibleRange(count, rowHeight, height, scrollTop, overscan);
  if (!Number.isSafeInteger(active) || active < -1) throw invalid();
  if (active < 0 || active >= count || (active >= range.first && active < range.end)) {
    return { first: range.first, end: range.end, top: range.top, bottom: range.bottom, active: -1, activeBefore: false, gap: 0 };
  }
  if (active < range.first) {
    return { first: range.first, end: range.end, top: active * rowHeight, bottom: range.bottom, active, activeBefore: true, gap: (range.first - active - 1) * rowHeight };
  }
  return { first: range.first, end: range.end, top: range.top, bottom: (count - active - 1) * rowHeight, active, activeBefore: false, gap: (active - range.end) * rowHeight };
}

const GAP_KEY = "\u0000gap";

interface VirtualConfig {
  count: () => number;
  key: (index: number) => string;
  keyed: boolean;
  render: (index: number) => El;
  renderRow: (row: VirtualRow) => El;
  rowHeight: number;
  height: number;
  overscan: number;
  scrollTop: Signal<number>;
  viewport: Signal<number> | null;
  autoSize: boolean;
  activeIndex: Signal<number> | null;
  label: string;
}

function emptyEl(): El {
  return { roots: [], cleanups: [] };
}

/** Fixed-height row wrapper. `prepare` runs once in the row scope; signals read directly by the returned builder rebuild only this row's content. */
function rowShell(rowHeight: number, prepare: () => (() => El)): El {
  return component(() => {
    const host = newId();
    createElement(host, "div");
    setAttr(host, "style", "height:" + rowHeight + "px;box-sizing:border-box");
    const content = prepare();
    let current = emptyEl();
    let first = true;
    const stop = effect(() => {
      const next = component(content);
      const previous = current;
      disposeEl(previous);
      for (let i = 0; i < previous.roots.length; i++) remove(previous.roots[i]!);
      for (let i = 0; i < next.roots.length; i++) append(host, next.roots[i]!);
      current = next;
      if (!first) flush();
      first = false;
    });
    liveRows++;
    return { roots: [host], cleanups: [() => { disposeEl(current); current = emptyEl(); }, stop, () => { liveRows--; }] };
  });
}

interface RowRecord { position: Signal<number>; value: number; }

function scrollerStyle(height: number): string {
  return "overflow:auto;height:" + height + "px;overflow-anchor:none";
}

function mountVirtual(cfg: VirtualConfig): El {
  return component(() => {
    const rowHeight = cfg.rowHeight;
    const measured = cfg.autoSize ? (cfg.viewport ?? signal(cfg.height)) : cfg.viewport;
    const viewportHeight = (): number => measured !== null ? measured.get() : cfg.height;
    const activeRow = (): number => cfg.activeIndex !== null ? cfg.activeIndex.get() : -1;
    const records = new Map<string, RowRecord>();
    let hostId = -1;
    let gapId = -1;
    let padStyle = "";
    let gapStyle = "";
    let plan: VirtualWindow = { first: 0, end: 0, top: 0, bottom: 0, active: -1, activeBefore: false, gap: 0 };

    effect(() => {
      const max = Math.max(0, cfg.count() * rowHeight - viewportHeight());
      const offset = cfg.scrollTop.get();
      if (Number.isFinite(max) && offset > max) cfg.scrollTop.set(max);
    });

    const applyPadding = (): void => {
      const style = "padding-top:" + plan.top + "px;padding-bottom:" + plan.bottom + "px";
      if (hostId >= 0 && style !== padStyle) setAttr(hostId, "style", style);
      padStyle = style;
    };
    const currentGapStyle = (): string => "height:" + plan.gap + "px";
    const gapItem = (): KeyedItem => ({
      key: GAP_KEY,
      build: (): El => {
        const id = newId();
        createElement(id, "div");
        setAttr(id, "aria-hidden", "true");
        gapStyle = currentGapStyle();
        setAttr(id, "style", gapStyle);
        gapId = id;
        return { roots: [id], cleanups: [() => { if (gapId === id) gapId = -1; }] };
      },
    });
    const rowItem = (index: number, keys: string[], indexes: number[]): KeyedItem => {
      const userKey = cfg.key(index);
      if (cfg.keyed) {
        const key = "=" + userKey;
        keys.push(key);
        indexes.push(index);
        return {
          key,
          build: (): El => rowShell(rowHeight, (): (() => El) => {
            const record: RowRecord = { position: signal(index), value: index };
            records.set(key, record);
            onScopeCleanup(() => { if (records.get(key) === record) records.delete(key); });
            const row: VirtualRow = { key: userKey, index: (): number => record.position.get() };
            return (): El => cfg.renderRow(row);
          }),
        };
      }
      return { key: userKey + ":" + index, build: (): El => rowShell(rowHeight, (): (() => El) => (): El => cfg.render(index)) };
    };

    const rows = each("div", (): KeyedItem[] => {
      const next = virtualWindow(cfg.count(), rowHeight, viewportHeight(), cfg.scrollTop.get(), cfg.overscan, activeRow());
      const items: KeyedItem[] = [];
      const keys: string[] = [];
      const indexes: number[] = [];
      if (next.active >= 0 && next.activeBefore) {
        items.push(rowItem(next.active, keys, indexes));
        items.push(gapItem());
      }
      for (let index = next.first; index < next.end; index++) items.push(rowItem(index, keys, indexes));
      if (next.active >= 0 && !next.activeBefore) {
        items.push(gapItem());
        items.push(rowItem(next.active, keys, indexes));
      }
      if (cfg.keyed) {
        const seen = new Map<string, number>();
        for (let i = 0; i < keys.length; i++) {
          if (seen.has(keys[i]!)) throw new Error("duplicate virtual row key: " + keys[i]!.slice(1));
          seen.set(keys[i]!, i);
        }
      }
      plan = next;
      applyPadding();
      const style = currentGapStyle();
      if (gapId >= 0 && style !== gapStyle) setAttr(gapId, "style", style);
      gapStyle = style;
      for (let i = 0; i < keys.length; i++) {
        const record = records.get(keys[i]!);
        if (record !== undefined && record.value !== indexes[i]!) {
          record.value = indexes[i]!;
          record.position.set(indexes[i]!);
        }
      }
      return items;
    });
    hostId = rows.roots[0]!;
    padStyle = "";
    applyPadding();

    const container = el("div", [rows]);
    dynProp(container, "scrollTop", () => "" + cfg.scrollTop.get());
    if (cfg.autoSize) {
      attr(container, "style", "overflow:auto;height:100%;min-height:0;overflow-anchor:none");
      onEvent(container, "resize", event => { if (measured !== null) measured.set(event.clientHeight ?? 0); });
    } else if (cfg.viewport !== null) dynAttr(container, "style", () => scrollerStyle(viewportHeight()));
    else attr(container, "style", scrollerStyle(cfg.height));
    if (cfg.label.length > 0) {
      attr(container, "aria-label", cfg.label);
      attr(container, "tabindex", "0");
    }
    liveLists++;
    container.cleanups.push(() => { liveLists--; });
    return onEvent(container, "scroll", (event) => {
      cfg.scrollTop.set(event.scrollTop ?? 0);
    });
  });
}

function noRender(_index: number): El {
  throw new Error("virtual row renderer missing");
}

function noRenderRow(_row: VirtualRow): El {
  throw new Error("virtual row renderer missing");
}

/** Index-identity list: a row is identified by key plus logical index, so a moved key remounts. */
export function virtualList(options: VirtualListOptions): El {
  return mountVirtual({
    count: options.count, key: options.key, keyed: false, render: options.render, renderRow: noRenderRow,
    rowHeight: options.rowHeight, height: options.height, overscan: options.overscan, scrollTop: options.scrollTop,
    viewport: options.viewport ?? null, autoSize: options.autoSize ?? false, activeIndex: options.activeIndex ?? null, label: options.label ?? "",
  });
}

/** Key-identity list: a row keeps its DOM and row-local state while its key stays in the window, even when its index changes. */
export function keyedVirtualList(options: KeyedVirtualListOptions): El {
  return mountVirtual({
    count: options.count, key: options.key, keyed: true, render: noRender, renderRow: options.renderRow,
    rowHeight: options.rowHeight, height: options.height, overscan: options.overscan, scrollTop: options.scrollTop,
    viewport: options.viewport ?? null, autoSize: options.autoSize ?? false, activeIndex: options.activeIndex ?? null, label: options.label ?? "",
  });
}

export function virtualTable(count: () => number, key: (row: number) => string, columns: VirtualColumn[], rowHeight: number, height: number, options?: VirtualTableOptions): El {
  if (columns.length === 0 || columns.length > 64) throw new Error("virtual table column limit");
  return component(() => {
    const extra: VirtualTableOptions = options ?? {};
    const grid = "display:grid;grid-template-columns:repeat(" + columns.length + ",minmax(0,1fr))";
    const headers: El[] = [];
    for (let i = 0; i < columns.length; i++) headers.push(attr(el("div", [txt(columns[i]!.header)]), "role", "columnheader"));
    const header = attr(attr(attr(el("div", headers), "role", "row"), "style", grid), "aria-rowindex", "1");
    const list = mountVirtual({
      count, key, keyed: false, rowHeight, height, overscan: extra.overscan ?? 3, scrollTop: extra.scrollTop ?? signal(0),
      viewport: extra.viewport ?? null, autoSize: extra.autoSize ?? false, activeIndex: extra.activeIndex ?? null, label: extra.label ?? "", renderRow: noRenderRow,
      render: (row: number) => {
        const cells: El[] = [];
        for (let i = 0; i < columns.length; i++) cells.push(attr(el("div", [columns[i]!.cell(row)]), "role", "cell"));
        return attr(attr(el("div", [attr(el("div", cells), "style", grid)]), "role", "row"), "aria-rowindex", "" + (row + 2));
      },
    });
    const table = attr(attr(el("div", [header, list]), "role", "table"), "aria-colcount", "" + columns.length);
    return dynAttr(table, "aria-rowcount", () => "" + (count() + 1));
  });
}

export function scrollToIndex(scrollTop: Signal<number>, index: number, count: number, rowHeight: number, height: number, alignment: string = "nearest"): number {
  visibleRange(count, rowHeight, height, scrollTop.get(), 0);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count || height <= 0) throw new Error("invalid virtual scroll target");
  const start = index * rowHeight, end = start + rowHeight, current = scrollTop.get();
  let target = current;
  if (alignment === "start") target = start;
  else if (alignment === "center") target = start - (height - rowHeight) / 2;
  else if (alignment === "end") target = end - height;
  else if (alignment === "nearest") {
    if (start < current) target = start;
    else if (end > current + height) target = end - height;
  } else throw new Error("unsupported virtual scroll alignment");
  target = Math.max(0, Math.min(target, Math.max(0, count * rowHeight - height)));
  if (target !== current) scrollTop.set(target);
  return target;
}
