declare function ntOnShortcutAction(cb: (id: number) => void): void;
declare function ntShortcutRegister(id: number, key: string, modifiers: number): number;
declare function ntShortcutUnregisterAll(): void;
declare function ntShortcutCount(): number;

export interface ShortcutModifiers {
  command?: boolean;
  option?: boolean;
  control?: boolean;
  shift?: boolean;
}

const handlers: Array<() => void> = [];
let callbackInstalled = false;

export function registerGlobalShortcut(
  key: string,
  modifiers: ShortcutModifiers,
  action: () => void,
): boolean {
  if (!callbackInstalled) {
    ntOnShortcutAction((id: number) => {
      const handler = handlers[id - 1];
      if (handler !== undefined) handler();
    });
    callbackInstalled = true;
  }
  const mask = (modifiers.command === true ? 1 : 0) |
    (modifiers.option === true ? 2 : 0) |
    (modifiers.control === true ? 4 : 0) |
    (modifiers.shift === true ? 8 : 0);
  const id = handlers.length + 1;
  if (ntShortcutRegister(id, key, mask) !== 1) return false;
  handlers.push(action);
  return true;
}

export function unregisterAllGlobalShortcuts(): void {
  ntShortcutUnregisterAll();
  handlers.splice(0, handlers.length);
}

export function getGlobalShortcutCount(): number { return ntShortcutCount(); }
