# Desktop lane cost

The desktop bridge sends `window.__nt.apply(<json>)` as source for the webview
to evaluate; the browser lane sends bytes. This measures both for one frame.

```sh
SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi \
  node $SCRIPTC build --lib --profile bench/desktop-lane/profile.json
node bench/desktop-lane/run.mjs 5000
```

Timings are V8, not JavaScriptCore, and exclude the native-to-webview call
itself (once per frame, not per byte).
