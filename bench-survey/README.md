# Compiled Wasm versus V8 survey

The same `ops.ts` runs through scriptc Wasm and Node's TypeScript stripping. Checksum equality gates timing; unsupported operations must be reported, not silently replaced.

```sh
./build.sh
node run.mjs
node coldwarm.mjs
```

Run from this directory with Node 24+ and the scriptc toolchain. `REPS` controls repetitions and `WARM` warmup calls. The runner alternates lanes, reports medians/ranges and writes ignored `results.json`; keep captured reports outside the source tree. `coldwarm.mjs` distinguishes first-call from warmed execution.

The ratio is compiled time divided by V8 time: lower is better. Do not extrapolate a microbenchmark to whole-application performance. `repro/` contains minimal compiler cases; inspect coverage before treating an omitted operation as a measured result.
