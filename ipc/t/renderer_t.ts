import { IpcRenderer } from "../renderer.js";
import { encodeUtf8, decodeUtf8 } from "../codec.js";

const ipc = new IpcRenderer();
let failures = 0;

function check(name: string, got: string, want: string): void {
  if (got === want) {
    console.log("ok   " + name);
  } else {
    console.log("FAIL " + name + ": got '" + got + "' want '" + want + "'");
    failures = failures + 1;
  }
}

ipc.on("tick", (payload: Uint8Array) => {
  check("event main->renderer", decodeUtf8(payload), "from-main");
});

async function run(): Promise<void> {
  const a = await ipc.invoke("echo", encodeUtf8("héllo"));
  check("invoke echo", decodeUtf8(a), "echo:héllo");

  const big = new Uint8Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  let expect = 0;
  for (let i = 0; i < big.length; i++) expect = expect + (i & 0xff);
  const b = await ipc.invoke("sum", big);
  check("invoke 200KB payload", decodeUtf8(b), "" + expect);

  let errMsg = "";
  try {
    await ipc.invoke("boom", encodeUtf8(""));
  } catch (e) {
    errMsg = (e as Error).message;
  }
  check("rejected handler", errMsg, "handler exploded");

  let missing = "";
  try {
    await ipc.invoke("nope", encodeUtf8(""));
  } catch (e) {
    missing = (e as Error).message;
  }
  check("unknown channel", missing, "no handler for channel: nope");

  const c = await ipc.invoke("run", encodeUtf8("spawned-from-main"));
  check("native spawn via ipc", decodeUtf8(c), "exit=0 out=Darwin");

  const r1 = ipc.invoke("echo", encodeUtf8("one"));
  const r2 = ipc.invoke("echo", encodeUtf8("two"));
  const r3 = ipc.invoke("echo", encodeUtf8("three"));
  check("concurrent 1", decodeUtf8(await r1), "echo:one");
  check("concurrent 2", decodeUtf8(await r2), "echo:two");
  check("concurrent 3", decodeUtf8(await r3), "echo:three");

  ipc.send("log", encodeUtf8("renderer done"));

  console.log(failures === 0 ? "IPC OK" : "IPC FAILURES: " + failures);
  process.exit(failures === 0 ? 0 : 1);
}

ipc.onOpen(() => { run(); });

const port = process.env.NT_IPC_PORT ?? "";
ipc.connect(+port, "127.0.0.1");
