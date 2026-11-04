# Fixed-row virtualisation

`virtualList({ count, key, render, rowHeight, height, overscan, scrollTop })` mounts only visible rows plus overscan. Count/key/render are application functions; `scrollTop` is a numeric framework signal. Rows outside the window are removed through normal component ownership, disposing effects, listeners and refs. Padding represents unmounted rows; DOM scroll height remains the full logical height. Row content is wrapped rather than having its styles overwritten.

`visibleRange(count, rowHeight, height, scrollTop, overscan)` is the pure range calculation. It validates finite positive geometry, nonnegative counts/offsets, integer overscan up to 1,000 and the generated scroll-height bound. Offsets clamp when the collection shrinks. No polling or 10k-node mount is used.

`virtualTable(count, key, columns, rowHeight, height)` adds header/row/cell roles and equal-width columns; columns are `{ header, cell(rowIndex) }`. It uses three overscan rows. This is not a full spreadsheet: variable row heights, column resizing, sorting and selection are application concerns. Fixed row height is a contract; overflowing content must be styled by the caller.

Key plus logical index identifies a mounted row. Reordering therefore remounts rows whose index changes rather than retaining closures bound to an obsolete index. In-place data edits should use signals in row components. Off-screen row-local state is disposed; persistent editing state belongs outside rows.

`abi/events.json` now declares `scroll` and a bounded finite `scrollTop` field. This changes the strict native event message to version 2 and regenerates projection, dispatch, guest decoders and reactor profiles. Plain click callbacks still use the slot-only tier. Negative scroll bounce is projected to zero; fractional offsets are preserved.

`node framework/components.test.mjs` builds a real reactor and verifies the 10,000-row case: 13 rows mount initially, 16 around the middle after a native DOM scroll event, and five remain after shrinking. It also checks table headers/windowing and component disposal. These are bounded DOM-count/correctness checks, not a new mount-time benchmark.
