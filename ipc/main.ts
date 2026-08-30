import { createServer } from "node:net";
import { FrameWriter, FrameReader, toBytes } from "./codec.js";
import { FRAME_REQUEST, FRAME_RESULT, FRAME_ERROR, FRAME_EVENT } from "./protocol.generated.js";

export type Handler = (payload: Uint8Array) => Promise<Uint8Array>;

export class IpcMain {
  private channels: string[] = [];
  private handlers: Handler[] = [];
  private eventChannels: string[] = [];
  private eventFns: ((payload: Uint8Array) => void)[] = [];
  private reader: FrameReader = new FrameReader();
  private peer: { write: (b: Uint8Array) => void } | null = null;
  private connected: (() => void)[] = [];
  private listening: ((port: number) => void)[] = [];

  handle(channel: string, fn: Handler): void {
    this.channels.push(channel);
    this.handlers.push(fn);
  }

  on(channel: string, fn: (payload: Uint8Array) => void): void {
    this.eventChannels.push(channel);
    this.eventFns.push(fn);
  }

  send(channel: string, payload: Uint8Array): void {
    const p = this.peer;
    if (p === null) return;
    const w = new FrameWriter();
    w.u8(FRAME_EVENT);
    w.str(channel);
    w.bytes(payload);
    p.write(w.finish());
  }

  onConnect(fn: () => void): void {
    this.connected.push(fn);
  }

  onListening(fn: (port: number) => void): void {
    this.listening.push(fn);
  }

  listen(port: number, host: string): void {
    const self = this;
    const srv = createServer((sock) => {
      self.peer = { write: (b: Uint8Array) => { sock.write(b); } };
      for (let i = 0; i < self.connected.length; i++) self.connected[i]!();
      sock.on("data", (d: Buffer) => {
        self.reader.push(toBytes(d));
        self.drain();
      });
    });
    srv.listen({ port, host });
    srv.on("listening", () => {
      const a = srv.address();
      if (a === null || typeof a === "string") return;
      for (let i = 0; i < self.listening.length; i++) self.listening[i]!(a.port);
    });
  }

  private drain(): void {
    const r = this.reader;
    while (r.next()) {
      const kind = r.u8();
      if (kind === FRAME_REQUEST) {
        const id = r.u32();
        const channel = r.str();
        const payload = r.bytes();
        r.release();
        this.dispatch(id, channel, payload);
      } else if (kind === FRAME_EVENT) {
        const channel = r.str();
        const payload = r.bytes();
        r.release();
        for (let i = 0; i < this.eventChannels.length; i++) {
          if (this.eventChannels[i] === channel) this.eventFns[i]!(payload);
        }
      } else {
        r.release();
      }
    }
  }

  private dispatch(id: number, channel: string, payload: Uint8Array): void {
    let found = -1;
    for (let i = 0; i < this.channels.length; i++) {
      if (this.channels[i] === channel) { found = i; break; }
    }
    if (found < 0) {
      this.fail(id, "no handler for channel: " + channel);
      return;
    }
    const self = this;
    this.handlers[found]!(payload)
      .then((out: Uint8Array) => { self.reply(id, out); })
      .catch((err: unknown) => {
        self.fail(id, err instanceof Error ? err.message : "handler failed");
      });
  }

  private reply(id: number, payload: Uint8Array): void {
    const p = this.peer;
    if (p === null) return;
    const w = new FrameWriter();
    w.u8(FRAME_RESULT);
    w.u32(id);
    w.bytes(payload);
    p.write(w.finish());
  }

  private fail(id: number, message: string): void {
    const p = this.peer;
    if (p === null) return;
    const w = new FrameWriter();
    w.u8(FRAME_ERROR);
    w.u32(id);
    w.str(message);
    p.write(w.finish());
  }
}
