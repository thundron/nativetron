# Canvas

A 2D canvas surface for compiled TypeScript. Draw calls are encoded into the
same kind of binary batch the DOM host uses and replayed against a real
`CanvasRenderingContext2D`.

`ops.json` is the source of truth; `node canvas/generate.mjs` emits the guest
API (`canvas.generated.ts`) and the host decoder (`canvas-host.generated.js`).
`--check` fails when either is stale.

```sh
node canvas/generate.mjs
SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi \
  node $SCRIPTC build --lib --profile canvas/profile.json
node canvas/verify.mjs
```

`verify.mjs` draws a scene from compiled wasm and the identical scene from
direct DOM calls, then compares every subpixel.

Coordinates travel as `f32`; styles, fonts and colours are interned like
element names. Numbers are rounded to float precision on the way out, so the
reference scene applies `Math.fround` to match.

| workload | compiled | direct JS |
|---|---|---|
| demo scene, ~90 ops | 0.026 ms | 0.010 ms |
| 1000 rects | 0.112 ms | 0.053 ms |
| 5000 rects | 0.42 ms | 0.177 ms |
| 20000 rects | 1.81 ms | 0.79 ms |

Roughly 2.3x the cost of drawing straight from JavaScript, and 20000 rects is
11% of a 60 fps frame.
