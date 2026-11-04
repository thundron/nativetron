import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleStats } from "./measure.js";

test("GPU timing statistics retain zeros, reject invalid samples and do not mutate input", () => {
  const input = [5, 1, 0, 4, 2];
  assert.deepEqual(sampleStats(input), { median: 2, p10: 0, p90: 4, min: 0, max: 5 });
  assert.deepEqual(input, [5, 1, 0, 4, 2]);
  for (const invalid of [[], [NaN], [Infinity], [-1]]) assert.throws(() => sampleStats(invalid), /invalid timing/);
});
