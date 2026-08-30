import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const glue = await import("./.scriptc/ops.mjs");
const wasm = readFileSync("./.scriptc/ops.wasm");
const median=(xs)=>{const s=[...xs].sort((a,b)=>a-b);return s[s.length>>1];};
for (const op of ["numBitOps","arrSort","numIntLoop"]) {
  const api = await glue.instantiateFromBytes(wasm, {}); // fresh instance -> cold tier
  const n = op==="numIntLoop"?10000:op==="numBitOps"?10000:2000;
  const t0=performance.now(); api["nt_"+op](n); const cold=performance.now()-t0;
  const ts=[]; for(let i=0;i<120;i++){const t=performance.now();api["nt_"+op](n);ts.push(performance.now()-t);}
  const warm=median(ts);
  console.log(op.padEnd(12), "cold(1st)="+cold.toFixed(3)+"ms", "warm_median="+warm.toFixed(3)+"ms", "cold/warm="+(cold/warm).toFixed(2)+"x");
}
