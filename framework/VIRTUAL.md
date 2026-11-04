# Fixed-row virtualisation

`framework/virtual.ts` mounts only the rows that intersect the viewport plus overscan. Every row has the same explicit `rowHeight` in CSS pixels; there is no measurement, estimation or variable-height mode, and content taller than `rowHeight` overflows its fixed shell rather than changing geometry. Padding and an optional spacer stand in for unmounted rows, so the DOM scroll height is always exactly `count × rowHeight`.

## API

`virtualList({ count, key, render, rowHeight, height, overscan, scrollTop })` is unchanged. Optional additive fields:

| field | meaning |
|---|---|
| `viewport: Signal<number>` | reactive viewport height in CSS pixels; replaces `height` and restyles the scroller |
| `activeIndex: Signal<number>` | logical row kept mounted while it is outside the window, for focus and editing; `-1` for none |
| `label: string` | `aria-label` on the scroller, which also becomes keyboard-focusable (`tabindex=0`) |

`keyedVirtualList({ count, key, renderRow, rowHeight, height, overscan, scrollTop, viewport?, activeIndex?, label? })` identifies rows by key alone. `renderRow(row)` receives `{ key, index() }`, where `index()` is a reactive signal read.

`virtualTable(count, key, columns, rowHeight, height, options?)` keeps its five-argument form; `options` may supply `scrollTop`, `viewport`, `activeIndex`, `overscan` (default 3) and `label`. The table has `role=table`, `aria-colcount`, a reactive `aria-rowcount` (rows plus header), `role=row`/`aria-rowindex` on the header (1) and every row (index + 2), and `role=columnheader`/`role=cell`. Variable row heights, column resizing, sorting and selection remain application concerns.

`visibleRange(count, rowHeight, height, scrollTop, overscan)` is the pure range; `virtualWindow(…, active)` adds the pinned row and spacer. Both require a safe-integer count, positive finite row height, finite height `0`–2³⁰ (a collapsed viewport is valid and mounts only overscan rows), finite nonnegative offset, integer overscan `0`–1,000, `count × rowHeight` within the generated 2³⁰ scroll bound, and an integer `active ≥ -1`; anything else throws `invalid virtual list geometry`. A reactive `count` or `viewport` that becomes invalid throws from the signal write that caused it. `virtualStats()` reports live containers and row shells; both return to zero after disposal.

## Behaviour

Scroll offset. `scrollTop` mirrors the DOM scroller and is written by the generated `scroll` event (`abi/events.json`, bounded finite `scrollTop`). Mounting a scroller writes `0`, because a new DOM scroller starts at the top. When the collection shrinks or the viewport grows, the DOM clamps its offset; the list writes the same clamped value back, so later growth does not render rows for an unreachable position. Application writes are not reflected in the DOM scroll position; see the open requirements below.

Jumps. Any offset maps directly to its range with no incremental walk; a jump replaces the window in one keyed diff. The Chrome test jumps across a 1,000,000-row, 16,000,000-pixel list and checks against the layout engine that the row at the scroller's top edge is `floor(scrollTop / rowHeight)`.

Empty, shrunk and grown collections. A count of zero mounts nothing and has zero padding. Shrinking removes rows through normal ownership and clamps the offset; growing re-extends the bottom padding.

Identity. `virtualList` identifies a row by key plus logical index, so `render(index)` closures never outlive their index: if the key at an index changes, or a key moves, that row remounts. Duplicate keys are therefore harmless there. `keyedVirtualList` keeps a row's DOM, effects and row-local state while its key remains in the window, even when it moves; `index()` updates, so read it inside `dyn` to avoid a rebuild. Keys must be unique across the collection. Uniqueness is checked for the mounted window on every update: a write that would mount a duplicate throws `duplicate virtual row key: …` before any DOM or row state changes, and the list stays subscribed and usable. A duplicate first exposed by user scrolling throws from the scroll event export, which reaches the host panic sink; it is a contract violation, not a recoverable state. Duplicates entirely outside the window are not detected until they are mounted.

Edits. Each row's builder runs in its own effect and component scope. Signal reads inside `dyn`, `dynAttr` or `dynProp` update that node in place. Signals read directly by `render`/`renderRow` (or a table `cell`) rebuild only that row's content inside its unchanged fixed-height shell. Signals and effects created by a row are disposed with it; persistent editing state belongs outside rows.

Focus and editing. Rows that leave the window are unmounted, which would drop focus and in-progress edits. Setting `activeIndex` (for example from the editor's `focus` event, cleared on `blur`) keeps that row mounted at its logical position: before the window it moves into the top padding with a spacer after it, after the window into the bottom padding with a spacer before it. The focused element, its value and caret survive scrolling away and back, and typing continues while it is offscreen. An `activeIndex` outside `[0, count)` is ignored, so shrinking past it unpins the row. `activeIndex` is a logical index: applications that reorder update it. With `label`, the scroller is a tab stop and the browser's native keyboard scrolling drives the window through ordinary scroll events (End, Home and PageDown are verified).

Disposal. Removing a list disposes its clamp and window effects, row scopes, listeners, refs, internal signals (including the table's default `scrollTop`) and the spacer. Rows are released through the same `each` ownership as other keyed lists.

## Verification

```sh
SCRIPTC=/path/to/scriptc/packages/cli/dist/main.js node framework/virtual.test.mjs
```

The test compiles `virtual.selftest.ts` natively and checks range, pinned-window, collapsed/fractional/huge offsets, exact pixel accounting and every refused input. It then builds `virtual.fixture.ts` as a wasm reactor (`virtual-profile.json`, `virtual-test.html`) and drives it in headless Chrome with DOM scrolling, CDP key and text input, focus and clicks: initial bounded windows for four lists; reactive viewport growth, shrink and collapse with offset clamping; 1,000,000-row jumps checked against layout; shrink/empty/grow and refused invalid counts; index-identity remounting; key-identity retention of DOM nodes and row-local click state across rotation and reversal; duplicate refusal with an intact window, and the panic for a scroll-exposed duplicate; in-place and direct-read edits; a pinned focused editor kept across 120,000-pixel scrolls with continued typing; a pinned row after the window and its release on shrink; native End/Home/PageDown scrolling; 1,200 compiled mount/scroll/reorder/dispose cycles with live row/list counts and wasm linear memory unchanged over the final 1,000; and 10 page-driven remounts that leave `#nt-root` empty. `node framework/components.test.mjs` continues to cover the original 10,000-row calls. These are correctness and boundedness checks, not timings.

## Open requirements outside this stream

- Programmatic scroll: the host's `SET_PROP` has no `scrollTop`, and FOCUS prevents scrolling. Scroll restoration, scroll-to-index and a keyboard row cursor that scrolls its row into view need a bounded scroll operation or property (finite, 0–2³⁰) owned by the ABI integrator; then `scrollTop` can become bidirectional. Until then the list resets the signal to the DOM's 0 on mount instead of showing an unreachable window.
- Automatic viewport size: no resize or element-size event exists, so `viewport` is application-supplied.
- A keydown default-action control would be needed before custom arrow-key handling could coexist with native scroller keys.
- Fixture generation: `abi/generate.mjs` does not yet own the event-export region of `virtual.fixture.ts` or the event exports in `virtual-profile.json`; the test asserts both equal the generated copies in `components.fixture.ts`/`components-profile.json`. The integrator should add the two files to the generator's targets.
- Browser engines cap element layout size well below the 2³⁰ guest bound, at engine-specific limits the guest cannot detect; only a 16,000,000-pixel list in Chrome is verified, so keep `count × rowHeight` at or under that unless the target engine is tested. WKWebView and other engines are not runtime-verified by this stream.
