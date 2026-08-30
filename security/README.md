# Transport safety

The desktop bridge can only reach the webview by evaluating source. Operands
therefore never appear in that source: `nt_send_ops` base64-encodes the op
buffer and evaluates `window.__nt.applyB64("<base64>")`, whose only variable
part is drawn from `[A-Za-z0-9+/=]`. No operand character can close the string
literal, so escaping correctness is not load-bearing.

```sh
SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi \
  node $SCRIPTC build --lib --profile security/profile.json
node security/transport.test.mjs
```

Payloads covered: quotes and backslashes, U+2028/U+2029, `</script>`, a
call-closing break-out, newlines and tabs, NUL and control characters.
