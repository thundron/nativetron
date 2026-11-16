# Benchmarks

Run comparable inputs and correctness gates before interpreting timing. Report warmup, repetitions, power/thermal state, competing workloads and variance; do not compare unmatched phases or extrapolate a microbenchmark to application performance.

```sh
cd bench
npm install
node run-bench.mjs
```

The runner compares native and Electron startup/runtime and writes ignored `last-run.json` and `last-run.md`. Keep reports outside the source tree. Subdirectories contain browser/React, canvas, codec, engine-BVH and desktop-lane fixtures; use their local READMEs or script headers for prerequisites and commands. Rebuild both lanes before timing and keep GPU measurements serial.
