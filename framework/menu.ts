declare function ntOnMenuAction(cb: (id: number) => void): void;
declare function ntMenuReset(): void;
declare function ntMenuAdd(menu: string, id: number, label: string, key: string, enabled: number): number;
declare function ntMenuItemCount(): number;
declare function ntOnContextAction(cb: (id: number) => void): void;
declare function ntContextMenuReset(): void;
declare function ntContextMenuAdd(id: number, label: string, enabled: number): number;
declare function ntContextMenuCount(): number;
declare function ntContextMenuShow(): number;
declare function ntOnTrayAction(cb: (id: number) => void): void;
declare function ntTraySet(id: number, title: string, tooltip: string): number;
declare function ntTraySetImage(path: string, templateImage: number): number;
declare function ntTrayMenuReset(): void;
declare function ntTrayMenuAdd(id: number, label: string, enabled: number): number;
declare function ntTrayMenuCount(): number;
declare function ntTrayRemove(): void;
declare function ntTrayPresent(): number;

export interface MenuItem {
  label: string;
  key?: string;
  enabled?: boolean;
  action?: () => void;
}

export interface ApplicationMenu {
  label: string;
  items: MenuItem[];
}

let menuHandlers: (() => void)[] = [];
let menuCallbackInstalled = false;
let contextHandlers: (() => void)[] = [];
let contextCallbackInstalled = false;
let trayHandlers: (() => void)[] = [];
let trayCallbackInstalled = false;

function handlerFor(item: MenuItem): () => void {
  return item.action === undefined ? () => {} : item.action;
}

export function setApplicationMenu(menus: ApplicationMenu[]): boolean {
  if (!menuCallbackInstalled) {
    ntOnMenuAction((id: number) => {
      const handler = menuHandlers[id - 1];
      if (handler !== undefined) handler();
    });
    menuCallbackInstalled = true;
  }
  ntMenuReset();
  menuHandlers = [];
  let ok = true;
  for (let i = 0; i < menus.length; i++) {
    const menu = menus[i]!;
    for (let j = 0; j < menu.items.length; j++) {
      const item = menu.items[j]!;
      const id = menuHandlers.length + 1;
      menuHandlers.push(handlerFor(item));
      if (ntMenuAdd(menu.label, id, item.label, item.key ?? "", item.enabled === false ? 0 : 1) !== 1) ok = false;
    }
  }
  return ok;
}

export function getApplicationMenuItemCount(): number { return ntMenuItemCount(); }

export function setContextMenu(items: MenuItem[]): boolean {
  if (!contextCallbackInstalled) {
    ntOnContextAction((id: number) => {
      const handler = contextHandlers[id - 1];
      if (handler !== undefined) handler();
    });
    contextCallbackInstalled = true;
  }
  ntContextMenuReset();
  contextHandlers = [];
  let ok = true;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const id = contextHandlers.length + 1;
    contextHandlers.push(handlerFor(item));
    if (ntContextMenuAdd(id, item.label, item.enabled === false ? 0 : 1) !== 1) ok = false;
  }
  return ok;
}

export function showContextMenu(items: MenuItem[]): boolean {
  return setContextMenu(items) && ntContextMenuShow() === 1;
}

export function getContextMenuItemCount(): number { return ntContextMenuCount(); }

function installTrayCallback(): void {
  if (trayCallbackInstalled) return;
  ntOnTrayAction((id: number) => {
    const handler = trayHandlers[id - 1];
    if (handler !== undefined) handler();
  });
  trayCallbackInstalled = true;
}

export function setTray(title: string, tooltip: string, action: () => void): boolean {
  installTrayCallback();
  trayHandlers = [action];
  return ntTraySet(1, title, tooltip) === 1;
}

export function setTrayImage(path: string, templateImage: boolean): boolean {
  return ntTraySetImage(path, templateImage ? 1 : 0) === 1;
}

export function setTrayMenu(items: MenuItem[]): boolean {
  installTrayCallback();
  ntTrayMenuReset();
  trayHandlers = [];
  let ok = true;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const id = trayHandlers.length + 1;
    trayHandlers.push(handlerFor(item));
    if (ntTrayMenuAdd(id, item.label, item.enabled === false ? 0 : 1) !== 1) ok = false;
  }
  return ok;
}

export function getTrayMenuItemCount(): number { return ntTrayMenuCount(); }

export function removeTray(): void {
  trayHandlers = [];
  ntTrayRemove();
}

export function hasTray(): boolean { return ntTrayPresent() === 1; }
