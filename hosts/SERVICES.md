# Page-facing host services

The iOS, Android and macOS reference hosts expose OS services independently of the compiled UI framework. Import `installHostServices` from `host/services.js`, or use `window.nativetronHost` in the engine example. A normal browser has no native broker and rejects calls with `unsupported`.

```js
const host = window.nativetronHost;
const capabilities = await host.capabilities();
const picked = await host.pickDocument({
  mimeTypes: ["application/json"],
  multiple: false,
});
// A file descriptor contains {file, name, size}; `file` is an opaque lease.
const bytes = await host.readFileChunk(picked[0].file, 0, Math.min(picked[0].size, 192 * 1024));
await host.releaseFile(picked[0].file);
```

Apple pickers also accept `extensions` and Apple-specific UTI identifiers in `types`. Android accepts MIME filters in `mimeTypes` (or the legacy `types` field); document providers ultimately control their chooser UI. Applications must validate imported formats. External content cannot select native filesystem paths through this API.

## Service surface

| Page API | Result and behavior |
|---|---|
| `capabilities()` | Version, feature availability, PDF output mode and storage bounds. |
| `pickDocument(options)` | Up to 16 selected documents, copied into native-owned file leases. |
| `pickGallery(options)` | System photo/media picker; returns the same file descriptors. |
| `saveAs({file,name,mime})` | Save/export a leased file through the native document UI. |
| `share({file,name,mime})` | Share a named snapshot. Android reports presentation, not recipient delivery. |
| `saveToGallery({file,name,mime})` | Save an image/video to Photos or MediaStore. Apple asks for permission; Android uses app-owned MediaStore insertion. |
| `pdf({html?,name?})` | Render supplied HTML or the current page with print styles; platform output differences are described below. |
| `print({html?,name?})` | Open the platform print UI. Submission does not prove physical printing. |
| `openFiles()` | Pending incoming file descriptors, retained until explicitly released. |
| `registerShortcuts(shortcuts)` | Atomically replace this page's shortcut registrations. |
| `onEvent(callback)` | Subscribe to `open-file`, `open-file-error` and `shortcut`; returns an unsubscribe function. |
| `archive.put(key, bytes)` | Chunked, acknowledged write followed by atomic commit. |
| `archive.get(key)` | Read a stable snapshot and release its lease. |
| `archive.list()` / `archive.remove(key)` | List or delete committed archives. |
| `readFileChunk(file,offset,length)` / `releaseFile(file)` | Read or release an opaque file lease. |

Cancellation is an error, not an empty successful selection. File leases should be retained while a save/share/gallery operation is outstanding and released afterwards. No file token is a path or a promise of lifetime across application termination.

## Persistent project archives

```js
await host.archive.put("project.ntproject", projectBytes);
const restored = await host.archive.get("project.ntproject");
const snapshot = await host.call("archive.stat", { key: "project.ntproject" });
try {
  await host.saveAs({ file: snapshot.file, name: "project.ntproject", mime: "application/vnd.nativetron.project" });
} finally {
  await host.releaseFile(snapshot.file);
}
```

Committed archives live in native application storage, not WebKit website storage. iOS keeps its nonpersistent website-data policy. Keys must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and cannot contain `..`. Limits are 256 MiB per file, 1 GiB of native archive/staging storage, 128 archive names, 16 staged writes and 32 file leases. Reads/writes use at most 192 KiB per chunk. Readers pin the committed version across atomic replacement. Incomplete writes are aborted on page teardown; abandoned staging files are removed when the exclusive archive store reopens.

These are application-private archives. User-requested export and system backup/uninstall behavior are separate. The Android reference manifest disables backup; deleting application data or uninstalling the application removes its archive.

## PDF and printing

Read `capabilities.pdfOutput` before assuming a PDF result is a file descriptor.

| Host | `pdfOutput` | Layout |
|---|---|---|
| iOS | `file` | UIKit print formatter, A4 paper with margins. |
| macOS | `file` | Asynchronous WebKit PDF capture with `mediaType = "print"`; continuous layout. Printing paginates that snapshot onto paper. |
| Android | `system-dialog` | Public WebView printing API; choose **Save as PDF** in the system destination UI. The result is a submitted job, not PDF bytes. |

Android's public SDK does not expose constructors for the callbacks needed to drive a WebView print adapter as a headless PDF writer. The host does not use hidden-API reflection or a debug-only DevTools endpoint. Callers needing headless PDF bytes on Android must supply their own supported PDF producer; this service does not claim that capability.

Supplied HTML is bounded and rendered in a separate view with no host bridge, scripts or remote resources. Bundled styles/fonts and data images are allowed. Apple waits for fonts/images before rendering and restores the page's original media override. macOS continuous export does not promise browser paged-media or `break-*` pagination parity. System print dialogs, printer behavior and mobile Photos/share flows still need device-level validation.

## Incoming files and associations

The reference hosts declare `.ntproject` / `application/vnd.nativetron.project` / `dev.nativetron.project`. Applications should substitute their own document declarations in the iOS project settings, Android manifest and macOS bundle metadata. The runtime handling is format-independent: iOS accepts cold-start URL contexts and later open events; Android accepts cold/warm `ACTION_VIEW` content URI grants; macOS accepts application open events. Selected/incoming content is copied into an owned file lease before the page reads it. Android does not use incoming `file://` paths or broad storage permissions.

Subscribe to `open-file` for live notifications and call `openFiles()` after startup to recover files received before the page was ready. Release each incoming file after importing it into the project archive. Native queues are bounded; failures are reported through `open-file-error`.

## Keyboard shortcuts

```js
await host.registerShortcuts([
  { id: "save", title: "Save project", key: "s", modifiers: ["meta"] },
]);
const unsubscribe = host.onEvent((event, value) => {
  if (event === "shortcut" && value.id === "save") saveProject();
});
```

Registrations are page-scoped and replaced as a set; navigation/disposal removes them. Up to 32 unique IDs/chords are accepted. Keys are lowercase ASCII letters/digits; modifiers are `meta`, `ctrl`, `alt`, `shift`. System close/quit and standard editing chords are reserved. Apple exposes registrations through native menus/key commands; Android uses the activity shortcut/menu surface. The reference engine also reserves its native clear-colour shortcut. Applications should register/unregister shortcuts as their own editing context changes rather than intercept unmodified text input.

## Embedding and validation

`hosts/apple/` contains the shared Apple service/storage/PDF code. `hosts/macos/build.sh` builds an unsigned WKWebView application using the same offline assets and services as iOS. `HostServices` on Android accepts an `Activity`, a `WebView` and the host's asset-serving callback; it does not require the compiled UI framework. The new client is not yet an adapter for the legacy Windows desktop service surface.

Focused checks include `node --test host/services.test.mjs`, the native archive tests, and the opt-in macOS `--host-selftest` probe. The latter requires a private `NT_HOST_ARCHIVE_ROOT` and tests a real WKWebView archive round-trip, shortcut registration and PDF print CSS without opening pickers or asking for Photos permission. Cross-build success is not execution evidence for mobile permission, picker, sharing, file-association or printer flows.
