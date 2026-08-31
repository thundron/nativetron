import { mount, quit, run, selftestRead } from "../framework/dom.js";
import { el, txt, dyn, attr, on, mountTo, each, type El, type KeyedItem } from "../framework/ui.js";
import { signal } from "../framework/reactive.js";
import { IpcRenderer } from "../ipc/renderer.js";
import { encodeUtf8, decodeUtf8 } from "../ipc/codec.js";
import { closeWindowFor, createWindow, getWindowCount, getWindowState, getWindowStateFor, hideWindow, hideWindowFor, minimizeWindow, onAnyWindowEvent, onWindowEvent, setWindowSizeFor, setWindowTitleFor, showWindow, showWindowFor } from "../framework/window.js";
import { readClipboard, writeClipboard, openExternal, notify } from "../framework/desktop.js";
import { getApplicationMenuItemCount, getContextMenuItemCount, getTrayMenuItemCount, hasTray, removeTray, setApplicationMenu, setContextMenu, setTray, setTrayImage, setTrayMenu } from "../framework/menu.js";
import { getGlobalShortcutCount, registerGlobalShortcut, unregisterAllGlobalShortcuts } from "../framework/shortcuts.js";
import { SAMPLE_REVIEW, SAFE_REVIEW } from "../pyrus/sample.js";
import type { ReleaseReview, ReleaseReviewRequest } from "../pyrus/release-review.js";

const ipc = new IpcRenderer();

const count = signal(0);
const items = signal<string[]>(["alpha", "beta", "gamma"]);
const nativeOut = signal("(nothing yet)");
const home = signal("");
const releaseOut = signal("(not reviewed)");
let seq = 0;

function button(label: string, handler: () => void): El {
  return on(attr(el("button", [txt(label)]), "style", "margin-right:8px"), "click", handler);
}

function ask(channel: string, arg: string): void {
  nativeOut.set("…");
  ipc.invoke(channel, encodeUtf8(arg))
    .then((reply: Uint8Array) => { nativeOut.set(decodeUtf8(reply)); })
    .catch((e: unknown) => {
      nativeOut.set("error: " + (e instanceof Error ? e.message : "failed"));
    });
}

function Counter(): El {
  return el("section", [
    el("h2", [txt("Counter")]),
    button("Increment", () => { count.set(count.get() + 1); }),
    el("p", [dyn(() => `count: ${count.get()}`)]),
  ]);
}

function List(): El {
  return el("section", [
    el("h2", [txt("Keyed list")]),
    button("Add", () => {
      seq++;
      const next = items.get().slice();
      next.push(`item-${seq}`);
      items.set(next);
    }),
    button("Remove first", () => {
      const next = items.get().slice();
      next.shift();
      items.set(next);
    }),
    button("Reverse", () => {
      const cur = items.get();
      const next: string[] = [];
      for (let i = cur.length - 1; i >= 0; i--) next.push(cur[i]!);
      items.set(next);
    }),
    each("ul", () => {
      const out: KeyedItem[] = [];
      const cur = items.get();
      for (let i = 0; i < cur.length; i++) {
        out.push({ key: cur[i]!, el: el("li", [txt(cur[i]!)]) });
      }
      return out;
    }),
    el("p", [dyn(() => `${items.get().length} items`)]),
  ]);
}

function requestReleaseReview(request: ReleaseReviewRequest): Promise<ReleaseReview> {
  return ipc.invoke("pyrus:review-release", encodeUtf8(JSON.stringify(request)))
    .then((payload: Uint8Array) => JSON.parse(decodeUtf8(payload)) as ReleaseReview);
}

function PyrusReleaseReview(): El {
  return el("section", [
    el("h2", [txt("Pyrus release review")]),
    button("Review sample release", () => {
      releaseOut.set("…");
      requestReleaseReview(SAMPLE_REVIEW)
        .then((review: ReleaseReview) => {
          const codes: string[] = [];
          for (let i = 0; i < review.findings.length; i++) codes.push(review.findings[i]!.code);
          releaseOut.set((review.blocking ? "blocked: " : "clear: ") + codes.join(", "));
        })
        .catch((e: unknown) => { releaseOut.set("error: " + (e instanceof Error ? e.message : "failed")); });
    }),
    el("pre", [attr(el("span", [dyn(() => releaseOut.get())]), "style", "white-space:pre-wrap")]),
  ]);
}

function Native(): El {
  return el("section", [
    el("h2", [txt("Native capability (main process)")]),
    button("Home dir", () => { ask("os:homedir", ""); }),
    button("UUID", () => { ask("crypto:uuid", ""); }),
    button("sha256", () => { ask("crypto:sha256", "nativetron"); }),
    button("List home", () => { ask("fs:list", home.get()); }),
    button("Run uname -a", () => { ask("proc:run", "/usr/bin/uname\n-a"); }),
    button("Unknown channel", () => { ask("does:not:exist", ""); }),
    el("pre", [
      attr(el("span", [dyn(() => nativeOut.get())]), "style", "white-space:pre-wrap"),
    ]),
  ]);
}

ipc.on("main:hello", (payload: Uint8Array) => {
  ipc.send("renderer:log", encodeUtf8("got main:hello = " + decodeUtf8(payload)));
});

mount("nativetron", 640, 640);
mountTo(el("main", [
  el("h1", [txt("nativetron")]),
  el("p", [txt("Renderer drives the DOM. Main process does native work over IPC.")]),
  Counter(),
  List(),
  PyrusReleaseReview(),
  Native(),
]));

async function selftest(): Promise<void> {
  const uuid = decodeUtf8(await ipc.invoke("crypto:uuid", encodeUtf8("")));
  const sha = decodeUtf8(await ipc.invoke("crypto:sha256", encodeUtf8("nativetron")));
  const uname = decodeUtf8(await ipc.invoke("proc:run", encodeUtf8("/usr/bin/uname\n-s")));
  let refused = "";
  try {
    await ipc.invoke("does:not:exist", encodeUtf8(""));
  } catch (e) {
    refused = e instanceof Error ? e.message : "?";
  }
  nativeOut.set(
    "uuid_len=" + uuid.length +
    " sha=" + sha +
    " uname=" + uname.trim() +
    " refused=" + refused,
  );
  const ok =
    uuid.length === 36 &&
    sha === "b5c7daeb69cd743cc77724a1e0513e476b195dcb60e656f804cf20e416b4bca3" &&
    uname.trim() === "Darwin" &&
    refused === "no handler for channel: does:not:exist";
  console.log(ok ? "NT_IPC_SELFTEST=OK" : "NT_IPC_SELFTEST=FAIL " + nativeOut.get());
  quit();
}

async function pyrusSelftest(): Promise<void> {
  const unsafe = await requestReleaseReview(SAMPLE_REVIEW);
  const safe = await requestReleaseReview(SAFE_REVIEW);
  const expected = ["local-state", "secret-file", "credential-pattern", "unexpected-binary",
    "nested-generated-output", "large-addition", "deletion"];
  let codesMatch = unsafe.findings.length === expected.length;
  for (let i = 0; i < expected.length && codesMatch; i++) {
    if (unsafe.findings[i]!.code !== expected[i]) codesMatch = false;
  }
  const ok = unsafe.blocking && unsafe.changelog.currentVersionPresent && codesMatch &&
    !safe.blocking && safe.findings.length === 0;
  console.log(ok ? "NT_PYRUS_SELFTEST=OK" : "NT_PYRUS_SELFTEST=FAIL");
  quit();
}

function menuSelftest(): void {
  const menuOk = setApplicationMenu([
    { label: "File", items: [
      { label: "First", key: "1", action: () => {} },
      { label: "-" },
      { label: "Disabled", enabled: false },
    ] },
    { label: "Edit", items: [{ label: "Copy", key: "c", action: () => {} }] },
  ]);
  const contextOk = setContextMenu([
    { label: "Inspect", action: () => {} },
    { label: "-" },
    { label: "Disabled", enabled: false },
  ]);
  const trayOk = setTray("NT", "nativetron self-test", () => {});
  const trayMenuOk = setTrayMenu([
    { label: "Open", action: () => {} },
    { label: "-" },
    { label: "Quit", action: () => {} },
  ]);
  const imageOk = setTrayImage(
    "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericApplicationIcon.icns",
    true,
  );
  const imageRefused = !setTrayImage("", true);
  const present = hasTray();
  const trayCount = getTrayMenuItemCount();
  removeTray();
  const ok = menuOk && getApplicationMenuItemCount() === 4 &&
    contextOk && getContextMenuItemCount() === 3 && trayOk && trayMenuOk &&
    trayCount === 3 && imageOk && imageRefused && present && !hasTray();
  console.log(ok ? "NT_MENU_SELFTEST=OK" : "NT_MENU_SELFTEST=FAIL");
  quit();
}

function shortcutSelftest(): void {
  const registered = registerGlobalShortcut(
    "F12",
    { command: true, option: true, control: true, shift: true },
    () => {},
  );
  const rejected = !registerGlobalShortcut("not-a-key", { command: true }, () => {});
  const count = getGlobalShortcutCount();
  unregisterAllGlobalShortcuts();
  const ok = registered && rejected && count === 1 && getGlobalShortcutCount() === 0;
  console.log(ok ? "NT_SHORTCUT_SELFTEST=OK" : "NT_SHORTCUT_SELFTEST=FAIL");
  quit();
}

function desktopSelftest(): void {
  const previous = readClipboard();
  const expected = "nativetron clipboard café 😀";
  writeClipboard(expected);
  const actual = readClipboard();
  writeClipboard(previous);
  const ok = actual === expected && !openExternal("") && !notify("", "");
  console.log(ok ? "NT_DESKTOP_SELFTEST=OK" : "NT_DESKTOP_SELFTEST=FAIL");
  quit();
}

function multipleWindowSelftest(): void {
  let id = 0;
  let sawResize = false;
  let sawClose = false;
  onAnyWindowEvent((windowId, event) => {
    if (windowId !== id) return;
    if (event === "resize") sawResize = true;
    if (event === "close") sawClose = true;
  });
  id = createWindow({
    title: "Nativetron secondary",
    width: 320,
    height: 180,
    source: "html",
    content: "<!doctype html><meta charset=utf-8><h1>secondary</h1>",
  });
  setWindowTitleFor(id, "Nativetron secondary updated");
  setWindowSizeFor(id, 360, 200);
  setTimeout(() => {
    const visible = getWindowStateFor(id).visible;
    hideWindowFor(id);
    const hidden = !getWindowStateFor(id).visible;
    showWindowFor(id);
    const shown = getWindowStateFor(id).visible;
    closeWindowFor(id);
    setTimeout(() => {
      const count = getWindowCount();
      const ok = id > 0 && visible && hidden && shown && sawResize && sawClose && count === 1;
      if (!ok) console.log("NT_MULTIPLE_WINDOW_DEBUG=" + id + "," + visible + "," + hidden + "," + shown + "," + sawResize + "," + sawClose + "," + count);
      console.log(ok ? "NT_MULTIPLE_WINDOW_SELFTEST=OK" : "NT_MULTIPLE_WINDOW_SELFTEST=FAIL");
      quit();
    }, 100);
  }, 200);
}

function windowSelftest(): void {
  let sawMinimize = false;
  let sawRestore = false;
  onWindowEvent((event) => {
    if (event === "minimize") sawMinimize = true;
    if (event === "restore") sawRestore = true;
  });
  const before = getWindowState();
  minimizeWindow();
  setTimeout(() => {
    const minimized = getWindowState();
    showWindow();
    setTimeout(() => {
      const restored = getWindowState();
      hideWindow();
      setTimeout(() => {
        const hidden = getWindowState();
        showWindow();
        setTimeout(() => {
          const shown = getWindowState();
          const ok = before.visible && minimized.minimized &&
            restored.visible && !restored.minimized && !hidden.visible && shown.visible &&
            sawMinimize && sawRestore;
          console.log(ok ? "NT_WINDOW_SELFTEST=OK" : "NT_WINDOW_SELFTEST=FAIL");
          quit();
        }, 150);
      }, 150);
    }, 150);
  }, 150);
}

ipc.onOpen(() => {
  if (process.env.NT_SELFTEST === "renderer-crash") {
    process.exit(23);
    return;
  }
  if (process.env.NT_SELFTEST === "stress-idle") console.log("NT_STRESS_READY=OK");
  ipc.invoke("os:homedir", encodeUtf8(""))
    .then((reply: Uint8Array) => { home.set(decodeUtf8(reply)); })
    .catch((e: unknown) => {});
  ipc.send("renderer:log", encodeUtf8("connected"));
  if (process.env.NT_SELFTEST === "ipc") selftest();
  if (process.env.NT_SELFTEST === "window") windowSelftest();
  if (process.env.NT_SELFTEST === "multiwindow") multipleWindowSelftest();
  if (process.env.NT_SELFTEST === "desktop") desktopSelftest();
  if (process.env.NT_SELFTEST === "menu") menuSelftest();
  if (process.env.NT_SELFTEST === "shortcut") shortcutSelftest();
  if (process.env.NT_SELFTEST === "pyrus") pyrusSelftest();
});
ipc.onClose(() => { quit(); });
ipc.connect(+(process.env.NT_IPC_PORT ?? "0"), "127.0.0.1");

run();
