# Commands

`createCommandRegistry()` returns `{ commands, register(command), execute(id) }`. A command is `{ id, labelKey, shortcut, enabled, run }`; `enabled` is a boolean framework signal. Registration validates catalogue labels, shortcut grammar, duplicate ids/normalised shortcuts and the 1,024-command bound. Execution checks enabled state again. `enabledCommands(registry, query)` is reactive and filters translated labels.

`commandPalette(registry)` returns an owned framework component. Meta+K and Control+K toggle it; the search input receives focus, Enter executes the first matching enabled command, Escape closes it, and buttons execute individual results. Disabled commands disappear reactively. Only one palette may own root key handling at once; disposal releases the listener. This is a basic dialog/palette, not a full ARIA combobox with roving selection or focus trapping.

`commands/keys.json` owns shortcut grammar and palette bindings; `node commands/generate.mjs --check` verifies guest/host outputs. Modifier names are Alt, Control, Meta and Shift, with a single alphanumeric, supported named key or F1–F12. Unsupported aliases fail explicitly.

In the page, `installCommandKeys(root, shortcutStrings = [])` from `commands/host.js` prevents browser defaults for the declared shortcuts and routes keys originating outside the compiled mount into it. It returns a disposer. Palette shortcuts are included automatically; pass application command shortcuts too. Routing stays in-page and uses the existing generated keyboard event projection. Native-global shortcuts remain a separate desktop capability.

Checks: `node --test commands/commands.test.mjs`; `node framework/components.test.mjs` compiles the palette, opens it from outside the root, verifies execution/disabled state and checks listener disposal.
