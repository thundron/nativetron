// Test-only wrapper around the real demo reactor glue: the instance traps in start() only inside a worker, so the
// failure happens after the canvas has been transferred while a main-thread retry on a new canvas still works.
import { instantiateFromBytes as instantiateDemo } from "../../gpu/.scriptc/demo.mjs";

export async function instantiateFromBytes(bytes, host) {
  const api = await instantiateDemo(bytes, host);
  if (typeof WorkerGlobalScope === "undefined") return api;
  return { ...api, ntgpu_start() { throw new Error("fixture trap in worker start"); } };
}
