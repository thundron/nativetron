import test from "node:test";
import assert from "node:assert/strict";
import { createHostServices, HOST_CHUNK_BYTES } from "./services.js";
function fake(handler) {
  const sent = []; let client;
  client = createHostServices({ random: () => "session", timeoutMs: 100, send: async message => {
    sent.push(message);
    const value = await handler(message);
    client.receive({ ntHost: 1, session: message.session, id: message.id, ok: true, value });
  } });
  return { client, sent };
}
test("async bridge errors reject immediately and do not consume request capacity", async () => {
  const client = createHostServices({ random: () => "s", send: async () => { throw new Error("unsupported"); } });
  for (let i = 0; i < 40; i++) await assert.rejects(client.capabilities(), /unsupported/);
  client.dispose();
});
test("archives are chunked and committed only after every acknowledged write", async () => {
  const { client, sent } = fake(message => message.method === "archive.begin" ? "transaction" : true);
  const bytes = new Uint8Array(HOST_CHUNK_BYTES * 2 + 7).fill(71);
  await client.archive.put("project.ntproject", bytes);
  assert.deepEqual(sent.map(m => m.method), ["archive.begin", "archive.write", "archive.write", "archive.write", "archive.commit"]);
  const chunks = sent.filter(m => m.method === "archive.write");
  assert.deepEqual(chunks.map(m => m.args.offset), [0, HOST_CHUNK_BYTES, HOST_CHUNK_BYTES * 2]);
  assert.deepEqual(chunks.map(m => atob(m.args.data).length), [HOST_CHUNK_BYTES, HOST_CHUNK_BYTES, 7]); client.dispose();
});
test("archive reads use stable snapshots and always release leases, including malformed data", async () => {
  const { client, sent } = fake(message => {
    if (message.method === "archive.stat") return { size: 7, file: "snapshot" };
    if (message.method === "files.read") return btoa("short");
    return true;
  });
  await assert.rejects(client.archive.get("project"), /changed/);
  assert.equal(sent.at(-1).method, "files.release"); client.dispose();
});
test("late responses from a previous session cannot satisfy a new page request", async () => {
  const sent = []; const client = createHostServices({ random: () => "new", send: m => sent.push(m) });
  const result = client.capabilities();
  client.receive({ ntHost: 1, session: "old", id: sent[0].id, ok: true, value: "wrong" });
  client.receive({ ntHost: 1, session: "new", id: sent[0].id, ok: true, value: "right" });
  assert.equal(await result, "right"); client.dispose();
});
test("host request capacity is bounded and disposal rejects outstanding promises", async () => {
  const client = createHostServices({ random: () => "s", send() {} });
  const results = Array.from({ length: 16 }, () => client.capabilities().catch(error => error.message));
  await assert.rejects(client.capabilities(), /capacity/); client.dispose();
  assert.ok((await Promise.all(results)).every(value => /disposed/.test(value)));
});
