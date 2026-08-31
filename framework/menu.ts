declare function ntOnMenuAction(cb: (id: number) => void): void;
declare function ntMenuReset(): void;
declare function ntMenuAdd(menu: string, id: number, label: string, key: string, enabled: number): number;
declare function ntMenuItemCount(): number;
declare function ntOnTrayAction(cb: (id: number) => void): void;
declare function ntTraySet(id: number, title: string, tooltip: string): number;
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
let trayHandler: (() => void) | null = null;
let trayCallbackInstalled = false;

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
      const action = item.action;
      menuHandlers.push(action === undefined ? () => {} : action);
      if (ntMenuAdd(menu.label, id, item.label, item.key ?? "", item.enabled === false ? 0 : 1) !== 1) {
        ok = false;
      }
    }
  }
  return ok;
}

export function getApplicationMenuItemCount(): number { return ntMenuItemCount(); }

export function setTray(title: string, tooltip: string, action: () => void): boolean {
  trayHandler = action;
  if (!trayCallbackInstalled) {
    ntOnTrayAction((_id: number) => {
      const handler = trayHandler;
      if (handler !== null) handler();
    });
    trayCallbackInstalled = true;
  }
  return ntTraySet(1, title, tooltip) === 1;
}

export function removeTray(): void {
  trayHandler = null;
  ntTrayRemove();
}

export function hasTray(): boolean { return ntTrayPresent() === 1; }
