import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { encodeEngineMessage, ENGINE_EVENT, ENGINE_COMMAND, LANE_ENGINE, LANE_NATIVE } from "./engine.generated.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env }; delete env.SCRIPTC_TARGET;
execFileSync("bash", [resolve(root, "ipc/build-control.sh")], { env, stdio: "inherit" });
const frame = encodeEngineMessage(ENGINE_EVENT, LANE_ENGINE, LANE_NATIVE, 42, 7, new Uint8Array([0, 255, 19]));
const request = encodeEngineMessage(ENGINE_COMMAND, LANE_NATIVE, LANE_ENGINE, 43981, 7, new Uint8Array([0, 255, 19]));
const temp = mkdtempSync(join(tmpdir(), "nt-control-"));
try {
  const source = `#include ${JSON.stringify(resolve(root, "ipc/control.generated.h"))}
#include <cassert>
#include <vector>
#include <cstdio>
#include <limits>
static int sends=0, receives=0;
static std::vector<uint8_t> sent, received;
static void send(void *context,const uint8_t *bytes,size_t length){assert(context==&sends);sends++;sent.assign(bytes,bytes+length);}
static void receive(void *context,const uint8_t *bytes,size_t length){assert(context==&receives);receives++;received.assign(bytes,bytes+length);}
int main(){
  assert(nt_control_set_callback("unknown",nullptr,nullptr)==-1);
  assert(nt_control_set_callback("controlSend",reinterpret_cast<void(*)(void)>(send),&sends)==0);
  assert(nt_control_set_callback("controlReceive",reinterpret_cast<void(*)(void)>(receive),&receives)==0);
  nt_control_init();
  const uint8_t payload[]={0,255,19};
  assert(nt_control_command(7,payload,sizeof(payload))==0); assert(sends==1); assert(sent.size()==19);
  assert(nt_control_receive(sent.data(),sent.size())==1);assert(receives==0);
  const uint8_t outbound[]={${[...request].join(",")}}; assert(nt_control_send(outbound,sizeof(outbound))==0); assert(sends==2); assert(sent==std::vector<uint8_t>(outbound,outbound+sizeof(outbound)));
  const uint8_t incoming[]={${[...frame].join(",")}};
  assert(nt_control_receive(incoming,sizeof(incoming))==0);assert(receives==1);
  assert(received==std::vector<uint8_t>(incoming,incoming+sizeof(incoming)));
  assert(nt_control_receive(nullptr,0)==1);
  assert(nt_control_command(-1,nullptr,0)==1);
  assert(nt_control_command(1.5,nullptr,0)==1);
  assert(nt_control_command(4294967296.0,nullptr,0)==1);
  assert(nt_control_command(std::numeric_limits<double>::quiet_NaN(),nullptr,0)==1);
  std::vector<uint8_t> oversized(65537);
  assert(nt_control_command(1,oversized.data(),oversized.size())==1);assert(sends==2);
  nt_control_collect(); puts("native control: callbacks, borrowed-data copies, routes and bounds passed");
}
`;
  writeFileSync(join(temp, "main.cc"), source);
  execFileSync("clang++", ["-std=c++17", join(temp, "main.cc"), resolve(root, "ipc/.scriptc/control.lib.a"), "-o", join(temp, "test")], { stdio: "inherit" });
  assert.match(execFileSync(join(temp, "test"), { encoding: "utf8" }), /routes and bounds passed/);
  console.log("native control: C ABI/routing conformance passed");
} finally { rmSync(temp, { recursive: true, force: true }); }
