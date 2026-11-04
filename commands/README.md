# Commands

## Registry

`createCommandRegistry()` returns `{ commands, register(command), execute(id), unregister(id), executeShortcut(shortcut), owner(shortcut), reserve(shortcut, owner), release(shortcut, owner) }`. A command is `{ id, labelKey, shortcut, enabled, run }`; `enabled` is a boolean framework signal and `shortcut` may be empty. `enabledCommands(registry, query)` is reactive (commands, enabled signals and the active locale) and filters translated labels case-insensitively after trimming the query.

Registration validates everything before changing state: a non-empty id of at most 128 characters that is not already registered, a catalogue label that formats without arguments (missing keys and argument-taking messages throw), the 1,024-command bound, and the shortcut rules below. `execute(id)` and `executeShortcut(shortcut)` re-check the enabled signal and return whether the command ran. `unregister(id)` removes a command and releases its shortcut.

Every normalised shortcut has at most one owner. `owner(shortcut)` returns `""`, `"palette"`, `"command:<id>"`, `"system: <reason>"` or a reservation owner; any spelling of a shortcut (`Shift+Meta+K`, `Meta+Shift+k`) names the same owner. `reserve(shortcut, owner)` claims a shortcut for a non-command owner (at most 1,024 reservations; owner names cannot be `palette`, `command:*` or `system*`) and `release(shortcut, owner)` returns it.

## Shortcut grammar and ownership

`commands/keys.json` is the single source for grammar, palette bindings and reservations; `node commands/generate.mjs` writes `keys.generated.ts` (guest) and `keys.generated.mjs` (page) from one template, and `--check` fails on drift. The generator validates the spec with the parser it generates: unknown or missing fields, modifiers that are not distinct single bits in ascending (canonical) order, malformed or case-duplicated named keys, unknown `commandModifiers`/`unmodifiedKeys`, unparsable or normalised-duplicate palette/reserved shortcuts, palette shortcuts without Control or Meta and non-plain reasons all fail. `--spec <path>` checks another spec without writing.

Modifier names are Alt, Control, Meta and Shift, each at most once, followed by one alphanumeric, a named key (Enter, Escape, ArrowUp, ArrowDown, Delete, Backspace, Tab) or F1–F12; at most 64 characters. Unsupported aliases (`Command`, `Space`, lower-case names) fail explicitly. The canonical spelling lists modifiers in bit order and lower-cases letters (`Meta+Shift+k`, `Control+F12`).

Command shortcuts must also leave typing alone: alphanumerics and named keys need Control or Meta (unmodified, Shift-only and Alt-only forms produce text, move focus or drive dialogs), while F1–F12 may stand alone. System and browser shortcuts that pages cannot or must not take (quit/close/hide/minimise, tab/window management, application switching, Alt+F4, clipboard and select-all) are reserved with a reason, and the palette's Meta+k/Control+k belong to the palette. Editor-local keys such as single-letter tools or Delete belong to the focused component's own keydown handler, not to the registry.

Key events match the layout-aware `key` first and fall back to the physical `code` (`KeyK`, `Digit1`) when modifiers turned a letter or digit into another character, so Control+Shift+1, Option+k and non-Latin layouts still match.

## Palette

`commandPalette(registry)` returns an owned framework component; only one may be mounted because it owns the root keydown listener, and disposal releases the listener, signals and effects so it can be mounted again. Meta+K and Control+K toggle it. Opening clears the query, makes the first enabled match active and focuses the search input.

The dialog is `role=dialog`, `aria-modal=true`, labelled by its title. The search input is a `combobox` controlling a `listbox` of `option` buttons (`tabindex=-1`, `aria-selected`, `aria-keyshortcuts`), with `aria-activedescendant` naming the active option. Option labels, title, search label, empty state and close text are reactive translations of `commands.title`, `commands.search`, `commands.empty` and `commands.close`.

With focus in the search input, unmodified ArrowDown/ArrowUp move the active option (wrapping), Home/End jump to the first/last option, and Enter runs the active option. Typing filters and resets the active option to the first match; with no matches the `role=status` empty message is shown and Enter does nothing. Disabling a command removes it reactively and clamps the active option. Escape closes from anywhere in the root. Clicking an option runs it. A command shortcut pressed while the palette is open closes it first; disabled shortcuts leave it open. Commands always run after the palette has closed, so they may move focus or reopen it. Enter, arrows and Home/End are handled only on the palette's own input, so they are never taken from unrelated inputs; ordinary typing never runs a command.

## Page half

In the page, `installCommandKeys(root, shortcutStrings = [])` from `commands/host.js` completes the contract for one mount root and returns a disposer that removes every listener and observer. Pass application command shortcuts; palette shortcuts are included automatically. `commandKeySet(shortcuts)` applies the same generated rules (it throws for text-editing, reserved, palette and normalised-duplicate shortcuts) and installing twice on one root throws.

- Declared shortcuts have their browser default suppressed and are routed into the root when they start outside it, through the existing generated keyboard event projection. Undeclared and reserved shortcuts keep their browser defaults.
- While the palette is open, the search input's navigation keys do not move the caret or submit forms, Escape is routed into the root even from outside it (e.g. focus on `body`), and IME composition keys never reach the palette.
- Focus is trapped: Tab/Shift+Tab cycle the dialog's tab stops (input and close button) and focus that escapes is returned to the input. On close or disposal, focus returns to the element that was focused before opening unless a command already moved focus elsewhere. The active option is scrolled into view.

## Native menus

On macOS the native application menu (`framework/menu.ts`) owns its key equivalents before the page sees them, so a shortcut must not be owned by both a menu item and a command. `menuKeyShortcut(key)` converts a menu key equivalent to a shortcut (`"s"` is Meta+s, `"S"` is Meta+Shift+s), `reserveMenuKey(registry, key, owner)` reserves it so commands cannot take it, and `shortcutMenuKey(shortcut)` returns the key equivalent for a command shortcut a menu can express (`""` otherwise). To surface a command in a native menu, either give the menu item no key and keep the command shortcut in-page, or reserve the menu key and leave the command without a shortcut; do not pass reserved menu keys to `installCommandKeys`. Native-global shortcuts (`framework/shortcuts.ts`) remain a separate desktop capability.

## Checks

`node --test commands/commands.test.mjs` covers generation drift, spec validation, grammar, normalisation, ownership rules, event projection and the page shortcut set. `SCRIPTC=<scriptc>/packages/cli/dist/main.js node commands/palette.test.mjs` compiles the owned `commands/palette.fixture.ts` reactor and drives it in headless Chrome with trusted keys: compiled registry rules, default suppression and routing, navigation, query/no-results, Enter/Escape, focus trap/restoration, disabled state and five dispose/remount cycles. `node framework/components.test.mjs` still exercises the palette inside the shared component fixture.

Not covered here: WKWebView/AppKit menu precedence on a real macOS shell, and locale switching (only the `en` catalogue exists; labels are bound reactively).
