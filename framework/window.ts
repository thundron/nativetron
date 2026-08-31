declare function ntSetTitle(title: string): void;
declare function ntSetSize(width: number, height: number): void;
declare function ntWindowAction(action: number): void;
declare function ntWindowState(): number;

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
