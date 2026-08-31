# JSX

scriptc accepts `.ts`, not `.tsx`, so JSX is transformed first:

    node app/jsx/build.mjs            # app.tsx -> app.generated.ts
    CCC_OVERRIDE_OPTIONS='+-lc++ +-framework +WebKit +-framework +Cocoa' \
      node "$SCRIPTC" build app/jsx/app.generated.ts --backend c \
        --ffi ffi/nativetron.ffi.json -o build/jsx-app

`build.mjs` uses TypeScript's own transpiler with `jsxFactory: "h"`.
`framework/jsx.ts` maps the emitted calls onto `framework/ui.ts`:

    h("div", props, ...children)   -> el / attr / on
    h(Component, null)             -> Component()
    string child                   -> txt
    () => string child             -> dyn   (the reactive binding)

Components are plain functions returning `El`. State is `signal()`. There is no
virtual DOM and no diff: `dyn` subscribes at compile time, so an update writes
the changed text directly.

Handlers are props whose value is a function; `onclick` becomes the `click`
listener. Everything else becomes an attribute.

## What the transform emits

| JSX | emitted |
|---|---|
| `<div a="1">x</div>` | `h("div", { a: "1" }, "x")` |
| `<Comp a={1} />` | `Comp({ a: 1 })` — a direct call, no factory |
| `<Comp>{x}</Comp>` | `Comp({ children: [...] })` |
| `{expr}` | `() => "" + (expr)` — a reactive text binding |
| `<div style={e}>` | `dynAttr(..., "style", () => "" + (e))` |
| `<ul>{xs.map(x => <li key={x}>..</li>)}</ul>` | `each("ul", () => xs.map(x => ({ key, el })))` |
| `{c ? <a/> : <b/>}` | `show(() => c, () => .., () => ..)` |
| `{c && <a/>}` | `show(() => c, () => .., nothing)` |

`key` is read out of the emitted props and removed from the DOM attributes.
A list child must be an inline `.map()` whose callback returns one element
with a `key`.

The generated file is TypeScript, not JavaScript: scriptc needs the
annotations, so it is printed rather than transpiled.

    node app/jsx/test.mjs
