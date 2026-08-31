declare function ntSetTitle(title: string): void;
declare function ntSetSize(width: number, height: number): void;
declare function ntWindowAction(action: number): void;
declare function ntWindowState(): number;
declare function ntOnWindowEvent(cb: (event: number) => void): void;
declare function ntCreateWindow(title: string, width: number, height: number, content: string, isHtml: number): number;
declare function ntWindowSetTitleFor(id: number, title: string): void;
declare function ntWindowSetSizeFor(id: number, width: number, height: number): void;
declare function ntWindowActionFor(id: number, action: number): void;
declare function ntWindowStateFor(id: number): number;
declare function ntWindowCount(): number;

export type WindowEvent = "move" | "resize" | "minimize" | "restore" | "focus" | "blur" | "enter-fullscreen" | "exit-fullscreen" | "close";

export interface WindowState {
  minimized: boolean;
  maximized: boolean;
  visible: boolean;
  focused: boolean;
  fullscreen: boolean;
}

export interface WindowOptions {
  title: string;
  width: number;
  height: number;
  content: string;
  source: "html" | "url";
}

export function setWindowTitle(title: string): void { ntSetTitle(title); }
export function setWindowSize(width: number, height: number): void { ntSetSize(width, height); }
export function minimizeWindow(): void { ntWindowAction(1); }
export function maximizeWindow(): void { ntWindowAction(2); }
export function toggleFullscreen(): void { ntWindowAction(3); }
export function showWindow(): void { ntWindowAction(4); }
export function hideWindow(): void { ntWindowAction(5); }
export function focusWindow(): void { ntWindowAction(6); }
export function closeWindow(): void { ntWindowAction(7); }

export function createWindow(options: WindowOptions): number {
  return ntCreateWindow(
    options.title,
    options.width,
    options.height,
    options.content,
    options.source === "html" ? 1 : 0,
  );
}

export function setWindowTitleFor(id: number, title: string): void { ntWindowSetTitleFor(id, title); }
export function setWindowSizeFor(id: number, width: number, height: number): void { ntWindowSetSizeFor(id, width, height); }
export function minimizeWindowFor(id: number): void { ntWindowActionFor(id, 1); }
export function maximizeWindowFor(id: number): void { ntWindowActionFor(id, 2); }
export function toggleFullscreenFor(id: number): void { ntWindowActionFor(id, 3); }
export function showWindowFor(id: number): void { ntWindowActionFor(id, 4); }
export function hideWindowFor(id: number): void { ntWindowActionFor(id, 5); }
export function focusWindowFor(id: number): void { ntWindowActionFor(id, 6); }
export function closeWindowFor(id: number): void { ntWindowActionFor(id, 7); }
export function getWindowCount(): number { return ntWindowCount(); }

function decodeWindowState(state: number): WindowState {
  return {
    minimized: (state & 1) !== 0,
    maximized: (state & 2) !== 0,
    visible: (state & 4) !== 0,
    focused: (state & 8) !== 0,
    fullscreen: (state & 16) !== 0,
  };
}

export function getWindowState(): WindowState { return decodeWindowState(ntWindowState()); }
export function getWindowStateFor(id: number): WindowState { return decodeWindowState(ntWindowStateFor(id)); }

let windowEventInstalled = false;
const windowEventHandlers: Array<(event: WindowEvent) => void> = [];
const allWindowEventHandlers: Array<(id: number, event: WindowEvent) => void> = [];

function installWindowEvents(): void {
  if (windowEventInstalled) return;
  ntOnWindowEvent((payload: number) => {
    const id = Math.floor(payload / 16);
    const code = payload - id * 16;
    const event: WindowEvent = code === 1 ? "move"
      : code === 2 ? "resize"
      : code === 3 ? "minimize"
      : code === 4 ? "restore"
      : code === 5 ? "focus"
      : code === 6 ? "blur"
      : code === 7 ? "enter-fullscreen"
      : code === 8 ? "exit-fullscreen" : "close";
    if (id === 0) {
      for (let i = 0; i < windowEventHandlers.length; i++) windowEventHandlers[i]!(event);
    }
    for (let i = 0; i < allWindowEventHandlers.length; i++) allWindowEventHandlers[i]!(id, event);
  });
  windowEventInstalled = true;
}

export function onWindowEvent(handler: (event: WindowEvent) => void): void {
  windowEventHandlers.push(handler);
  installWindowEvents();
}

export function onAnyWindowEvent(handler: (id: number, event: WindowEvent) => void): void {
  allWindowEventHandlers.push(handler);
  installWindowEvents();
}
