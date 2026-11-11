// Page-facing OS services. Independent of the UI framework and engine wire.
export const HOST_CHUNK_BYTES = 192 * 1024;
export const HOST_MAX_FILE_BYTES = 256 * 1024 * 1024;
export function createHostServices({ send, timeoutMs = 120000, random = () => crypto.randomUUID() }) {
  const session = random(), pending = new Map(), listeners = new Set();
  let next = 1, closed = false;
  const call = (method, args = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("host services disposed"));
    if (pending.size >= 16) return reject(new Error("host request capacity exceeded"));
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`host service timed out: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      const message = { ntHost: 1, session, id, method, args };
      if (new TextEncoder().encode(JSON.stringify(message)).length > 512 * 1024) throw new Error("host request exceeds 512 KiB");
      Promise.resolve(send(message)).catch(error => { clearTimeout(timer); if (pending.delete(id)) reject(error); });
    }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const base64 = bytes => { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
  const unbase64 = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
  const client = {
    call,
    get disposed() { return closed; },
    releaseFile: file => call("files.release", { file }),
    readFileChunk: (file, offset, length) => call("files.read", { file, offset, length }).then(unbase64),
    receive(message) {
      if (closed || message?.ntHost !== 1) return;
      if (message.event) { for (const fn of listeners) { try { fn(message.event, message.value); } catch {} } return; }
      if (message.session !== session) return;
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.ok) request.resolve(message.value); else request.reject(Object.assign(new Error(message.error?.message ?? "host service failed"), { code: message.error?.code ?? "host-error" }));
    },
    capabilities: () => call("capabilities"),
    pickDocument: options => call("files.pick", options),
    pickGallery: options => call("gallery.pick", options),
    saveAs: options => call("files.save", options),
    share: options => call("files.share", options),
    saveToGallery: options => call("gallery.save", options),
    pdf: options => call("document.pdf", options),
    print: options => call("document.print", options),
    openFiles: () => call("files.incoming"),
    registerShortcuts: shortcuts => call("shortcuts.set", { shortcuts }),
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    archive: {
      list: () => call("archive.list"),
      remove: key => call("archive.delete", { key }),
      async put(key, bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length > HOST_MAX_FILE_BYTES) throw new Error("invalid archive bytes");
        const transaction = await call("archive.begin", { key, size: bytes.length });
        try {
          for (let offset = 0; offset < bytes.length; offset += HOST_CHUNK_BYTES)
            await call("archive.write", { transaction, offset, data: base64(bytes.subarray(offset, offset + HOST_CHUNK_BYTES)) });
          return await call("archive.commit", { transaction });
        } catch (error) { await call("archive.abort", { transaction }).catch(() => {}); throw error; }
      },
      async get(key) {
        const file = await call("archive.stat", { key });
        try {
          if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > HOST_MAX_FILE_BYTES) throw new Error("invalid archive size");
          const bytes = new Uint8Array(file.size);
          for (let offset = 0; offset < file.size; offset += HOST_CHUNK_BYTES) {
            const chunk = unbase64(await call("files.read", { file: file.file, offset, length: Math.min(HOST_CHUNK_BYTES, file.size - offset) }));
            if (chunk.length !== Math.min(HOST_CHUNK_BYTES, file.size - offset)) throw new Error("archive changed during read");
            bytes.set(chunk, offset);
          }
          return bytes;
        } finally { if (typeof file?.file === "string") await call("files.release", { file: file.file }).catch(() => {}); }
      },
    },
    dispose() { closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("host services disposed")); } pending.clear(); listeners.clear(); },
  };
  return client;
}

export function installHostServices(scope = globalThis) {
  const client = createHostServices({
    random: () => Array.from(scope.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""),
    async send(message) {
      if (scope.ntHost && !scope.__ntHostToken) await new Promise((resolve, reject) => {
        const ready = () => { clearTimeout(timer); scope.removeEventListener("nt-host-ready", ready); resolve(); };
        const timer = setTimeout(() => { scope.removeEventListener("nt-host-ready", ready); reject(new Error("native host handshake timed out")); }, 10000);
        scope.addEventListener("nt-host-ready", ready, { once: true });
      });
      if (client.disposed) throw new Error("host services disposed");
      const apple = scope.webkit?.messageHandlers?.ntHost;
      if (apple) apple.postMessage(message);
      else if (scope.ntHost && scope.__ntHostToken) scope.ntHost.postMessage(JSON.stringify({ ...message, token: scope.__ntHostToken }));
      else throw Object.assign(new Error("native host services unavailable"), { code: "unsupported" });
    },
  });
  scope.__ntHostReceive = message => client.receive(message);
  scope.addEventListener?.("pagehide", () => client.dispose(), { once: true });
  return client;
}
