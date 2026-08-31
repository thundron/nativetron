import { IpcRenderer } from "../ipc/renderer.js";
import { decodeUtf8 } from "../ipc/codec.js";

declare function ntOnOpenFile(cb: (path: string) => void): void;
declare function ntOnOpenUrl(cb: (url: string) => void): void;
declare function ntAssociationsStart(): number;
declare function ntAssociationsSelftest(file: string, url: string): number;

export function onOpenFile(ipc: IpcRenderer, handler: (path: string) => void): void {
  ipc.on("app:open-file", (payload: Uint8Array) => { handler(decodeUtf8(payload)); });
}

export function onOpenUrl(ipc: IpcRenderer, handler: (url: string) => void): void {
  ipc.on("app:open-url", (payload: Uint8Array) => { handler(decodeUtf8(payload)); });
}
