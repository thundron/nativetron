declare function ntSetTitle(title: string): void;
declare function ntSetSize(width: number, height: number): void;
declare function ntWindowAction(action: number): void;
declare function ntWindowState(): number;
declare function ntOnWindowEvent(cb: (event: number) => void): void;

export type WindowEvent = "move" | "resize" | "minimize" | "restore" | "focus" | "blur" | "enter-fullscreen" | "exit-fullscreen" | "close";

export interface WindowState {
  minimized: boolean;
  maximized: boolean;
  visible: boolean;
  focused: boolean;
  fullscreen: boolean;
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

let windowEventInstalled = false;
const windowEventHandlers: Array<(event: WindowEvent) => void> = [];

export function onWindowEvent(handler: (event: WindowEvent) => void): void {
  windowEventHandlers.push(handler);
  if (windowEventInstalled) return;
  ntOnWindowEvent((code: number) => {
    const event: WindowEvent = code === 1 ? "move"
      : code === 2 ? "resize"
      : code === 3 ? "minimize"
      : code === 4 ? "restore"
      : code === 5 ? "focus"
      : code === 6 ? "blur"
      : code === 7 ? "enter-fullscreen"
      : code === 8 ? "exit-fullscreen" : "close";
    for (let i = 0; i < windowEventHandlers.length; i++) windowEventHandlers[i]!(event);
  });
  windowEventInstalled = true;
}

export function getWindowState(): WindowState {
  const state = ntWindowState();
  return {
    minimized: (state & 1) !== 0,
    maximized: (state & 2) !== 0,
    visible: (state & 4) !== 0,
    focused: (state & 8) !== 0,
    fullscreen: (state & 16) !== 0,
  };
}
