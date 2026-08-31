import { createConnection } from "node:net";
import { FrameWriter, FrameReader, toBytes } from "./codec.js";
import { FRAME_REQUEST, FRAME_RESULT, FRAME_ERROR, FRAME_EVENT } from "./protocol.generated.js";

export class IpcRenderer {
  private reader: FrameReader = new FrameReader();
  private sock: { write: (b: Uint8Array) => void } | null = null;
  private nextId: number = 1;
  private pendingIds: number[] = [];
  private pendingOk: ((b: Uint8Array) => void)[] = [];
  private pendingErr: ((e: Error) => void)[] = [];
  private eventChannels: string[] = [];
  private eventFns: ((payload: Uint8Array) => void)[] = [];
  private opened: (() => void)[] = [];
  private closed: (() => void)[] = [];
  private stopped: boolean = false;

  on(channel: string, fn: (payload: Uint8Array) => void): void {
    this.eventChannels.push(channel);
    this.eventFns.push(fn);
  }

  onOpen(fn: () => void): void {
    this.opened.push(fn);
  }

  onClose(fn: () => void): void {
    this.closed.push(fn);
  }

  connect(port: number, host: string): void {
    const self = this;
    this.stopped = false;
    this.reader.reset();
    const c = createConnection({ port, host });
    c.on("connect", () => {
      self.sock = { write: (b: Uint8Array) => { c.write(b); } };
      for (let i = 0; i < self.opened.length; i++) self.opened[i]!();
    });
    c.on("data", (d: Buffer) => {
      try {
        self.reader.push(toBytes(d));
        self.drain();
      } catch (_e) {
        c.destroy();
        self.shutdown();
      }
    });
    c.on("close", () => { self.shutdown(); });
    c.on("error", () => { self.shutdown(); });
  }

  private shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sock = null;
    this.reader.reset();
    for (let i = 0; i < this.pendingErr.length; i++) {
      this.pendingErr[i]!(new Error("ipc disconnected"));
    }
    this.pendingIds = [];
    this.pendingOk = [];
    this.pendingErr = [];
    for (let i = 0; i < this.closed.length; i++) this.closed[i]!();
  }

  send(channel: string, payload: Uint8Array): void {
    const s = this.sock;
    if (s === null) return;
    const w = new FrameWriter();
    w.u8(FRAME_EVENT);
    w.str(channel);
    w.bytes(payload);
    s.write(w.finish());
  }

  invoke(channel: string, payload: Uint8Array): Promise<Uint8Array> {
    const self = this;
    const id = this.nextId;
    this.nextId = this.nextId + 1;
    return new Promise<Uint8Array>((resolve, reject) => {
      const s = self.sock;
      if (s === null) {
        reject(new Error("ipc not connected"));
        return;
      }
      self.pendingIds.push(id);
      self.pendingOk.push(resolve);
      self.pendingErr.push(reject);
      const w = new FrameWriter();
      w.u8(FRAME_REQUEST);
      w.u32(id);
      w.str(channel);
      w.bytes(payload);
      s.write(w.finish());
    });
  }

  private settle(id: number, payload: Uint8Array, message: string, ok: boolean): void {
    let at = -1;
    for (let i = 0; i < this.pendingIds.length; i++) {
      if (this.pendingIds[i] === id) { at = i; break; }
    }
    if (at < 0) return;
    const okFn = this.pendingOk[at]!;
    const errFn = this.pendingErr[at]!;
    this.pendingIds.splice(at, 1);
    this.pendingOk.splice(at, 1);
    this.pendingErr.splice(at, 1);
    if (ok) okFn(payload);
    else errFn(new Error(message));
  }

  private drain(): void {
    const r = this.reader;
    while (r.next()) {
      const kind = r.u8();
      if (kind === FRAME_RESULT) {
        const id = r.u32();
        const payload = r.bytes();
        r.finish();
        r.release();
        this.settle(id, payload, "", true);
      } else if (kind === FRAME_ERROR) {
        const id = r.u32();
        const message = r.str();
        r.finish();
        r.release();
        this.settle(id, new Uint8Array(0), message, false);
      } else if (kind === FRAME_EVENT) {
        const channel = r.str();
        const payload = r.bytes();
        r.finish();
        r.release();
        for (let i = 0; i < this.eventChannels.length; i++) {
          if (this.eventChannels[i] === channel) this.eventFns[i]!(payload);
        }
      } else {
        throw new Error("unknown ipc frame kind: " + kind);
      }
    }
  }
}
