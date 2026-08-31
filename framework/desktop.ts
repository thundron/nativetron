declare function ntClipboardWrite(text: string): void;
declare function ntClipboardRead(cb: (text: string) => void): void;
declare function ntOpenExternal(url: string): number;
declare function ntOpenDialog(directories: number, multiple: number, cb: (paths: string) => void): void;
declare function ntSaveDialog(cb: (path: string) => void): void;
declare function ntNotificationsAvailable(): number;
declare function ntOnNotificationPermission(cb: (granted: number) => void): void;
declare function ntRequestNotificationPermission(): number;
declare function ntNotify(title: string, body: string): number;

export interface OpenDialogOptions {
  directories?: boolean;
  multiple?: boolean;
}

export function writeClipboard(text: string): void { ntClipboardWrite(text); }

export function readClipboard(): string {
  let value = "";
  ntClipboardRead((text: string) => { value = text; });
  return value;
}

export function openExternal(url: string): boolean { return ntOpenExternal(url) === 1; }

export function openDialog(options: OpenDialogOptions): string[] {
  let value = "";
  ntOpenDialog(options.directories === true ? 1 : 0, options.multiple === true ? 1 : 0,
    (paths: string) => { value = paths; });
  if (value === "") return [];
  return value.split("\n");
}

export function saveDialog(): string | null {
  let value = "";
  ntSaveDialog((path: string) => { value = path; });
  return value === "" ? null : value;
}

let notificationPermissionInstalled = false;
const notificationPermissionHandlers: Array<(granted: boolean) => void> = [];

export function notificationsAvailable(): boolean { return ntNotificationsAvailable() === 1; }

export function requestNotificationPermission(handler: (granted: boolean) => void): boolean {
  if (notificationPermissionHandlers.length !== 0) return false;
  if (!notificationPermissionInstalled) {
    ntOnNotificationPermission((granted: number) => {
      const pending = notificationPermissionHandlers[0];
      notificationPermissionHandlers.splice(0, notificationPermissionHandlers.length);
      if (pending !== undefined) pending(granted === 1);
    });
    notificationPermissionInstalled = true;
  }
  notificationPermissionHandlers.push(handler);
  if (ntRequestNotificationPermission() === 1) return true;
  notificationPermissionHandlers.splice(0, notificationPermissionHandlers.length);
  return false;
}

export function notify(title: string, body: string): boolean {
  return ntNotify(title, body) === 1;
}
